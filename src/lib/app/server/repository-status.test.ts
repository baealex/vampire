import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { closeRepositoryStatusObservers, observeRepositoryStatus } from './repository-status.server.ts';
import type { TerminalServerMessage } from '~/lib/shared/contracts/terminal-protocol.ts';

const run = promisify(execFile);
type RepositoryStatusMessage = Extract<TerminalServerMessage, { type: 'repository-status' }>;

class TestSocket extends EventEmitter {
  readyState = 1;
  messages: RepositoryStatusMessage[] = [];

  send(payload: string): void {
    this.messages.push(JSON.parse(payload) as RepositoryStatusMessage);
  }

  close(): void {
    this.readyState = 3;
    this.emit('close');
  }
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await run('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Vampire Test',
      GIT_AUTHOR_EMAIL: 'vampire@example.test',
      GIT_COMMITTER_NAME: 'Vampire Test',
      GIT_COMMITTER_EMAIL: 'vampire@example.test',
    },
  });
}

async function waitFor(predicate: () => boolean, timeout = 3_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeout) throw new Error('Timed out waiting for repository status.');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('pushes Git change counts and releases its watcher with the socket', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'vampire-repository-status-'));
  const stateDirectory = join(root, 'state');
  const workspace = join(root, 'workspace');
  const previousStateDirectory = process.env.VAMPIRE_STATE_DIR;
  process.env.VAMPIRE_STATE_DIR = stateDirectory;
  t.after(async () => {
    closeRepositoryStatusObservers();
    if (previousStateDirectory === undefined) delete process.env.VAMPIRE_STATE_DIR;
    else process.env.VAMPIRE_STATE_DIR = previousStateDirectory;
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(workspace);
  await git(workspace, 'init', '--quiet');
  await writeFile(join(workspace, 'app.js'), 'export const value = 1;\n');
  await git(workspace, 'add', '.');
  await git(workspace, 'commit', '--quiet', '-m', 'initial');
  const linkedWorktree = join(root, 'linked-worktree');
  await git(workspace, 'worktree', 'add', '--quiet', '-b', 'status-worktree-test', linkedWorktree);
  await mkdir(stateDirectory);
  const workspaceId = 'e272a1ce-550a-48a6-8d4a-5ef1cef1b46';
  await writeFile(
    join(stateDirectory, 'sessions.json'),
    JSON.stringify({
      version: 1,
      workspaces: [{ id: workspaceId, tmuxSession: 'vampire-e272a1ce', cwd: workspace }],
    })
  );

  const socket = new TestSocket();
  await observeRepositoryStatus(socket, workspaceId);
  await waitFor(() =>
    socket.messages.some((message) => message.type === 'repository-status' && message.changeCount === 0)
  );
  assert.equal(socket.messages.at(-1)?.worktreeCount, 2);

  await git(workspace, 'worktree', 'remove', '--force', linkedWorktree);
  await waitFor(() => socket.messages.at(-1)?.worktreeCount === 1);

  await writeFile(join(workspace, 'app.js'), 'export const value = 2;\n');
  await waitFor(() =>
    socket.messages.some((message) => message.type === 'repository-status' && message.changeCount === 1)
  );

  await git(workspace, 'add', 'app.js');
  await git(workspace, 'commit', '--quiet', '-m', 'update');
  await waitFor(
    () => socket.messages.filter((message) => message.type === 'repository-status').at(-1)?.changeCount === 0
  );

  const messageCountBeforeClose = socket.messages.length;
  socket.close();
  await writeFile(join(workspace, 'app.js'), 'export const value = 3;\n');
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(socket.messages.length, messageCountBeforeClose);
});
