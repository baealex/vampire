import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  inferAgentState,
  readWorkspaceAgentStates,
} from '~/lib/features/workspace/server/workspace-agent-activity.server.ts';

const foregroundCommand = { kind: 'command' as const, label: 'project-runner' };

test('keeps an agent working while its interrupt status is visible', () => {
  assert.equal(
    inferAgentState(
      foregroundCommand,
      `
• Ran pnpm check

◦ Working (25s • esc to interrupt)

› Explain this codebase
`
    ),
    'working'
  );
});

test('marks an agent waiting only after its working status has cleared', () => {
  assert.equal(
    inferAgentState(
      foregroundCommand,
      `
The change is complete.

─ Worked for 1m 12s ─────────

› Explain this codebase
`
    ),
    'waiting'
  );
});

test('infers display state for an arbitrary foreground command', () => {
  assert.equal(inferAgentState({ kind: 'command', label: 'node' }, '> '), 'waiting');
  assert.equal(inferAgentState({ kind: 'shell', label: 'zsh' }, '> '), null);
});

test('batches captures and preserves other agent states when a window disappears', async (t) => {
  const run = promisify(execFile);
  const realTmux = (await run('which', ['tmux'])).stdout.trim();
  const root = await mkdtemp(join(tmpdir(), 'vampire-agent-captures-'));
  const socket = `vampire-captures-${process.pid}`;
  const previousPath = process.env.PATH;
  const previousSocket = process.env.VAMPIRE_TMUX_SOCKET_NAME;
  t.after(async () => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousSocket === undefined) delete process.env.VAMPIRE_TMUX_SOCKET_NAME;
    else process.env.VAMPIRE_TMUX_SOCKET_NAME = previousSocket;
    await run(realTmux, ['-L', socket, 'kill-server']).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  const tmux = (...args: string[]) => run(realTmux, ['-L', socket, ...args]);
  const waiting = (
    await tmux(
      'new-session',
      '-d',
      '-x',
      '80',
      '-y',
      '10',
      '-s',
      'waiting',
      '-P',
      '-F',
      '#{window_id}',
      "printf '> ready\\n'; sleep 30"
    )
  ).stdout.trim();
  const working = (
    await tmux(
      'new-session',
      '-d',
      '-x',
      '80',
      '-y',
      '10',
      '-s',
      'working',
      '-P',
      '-F',
      '#{window_id}',
      "printf 'esc to interrupt\\n'; sleep 30"
    )
  ).stdout.trim();
  for (const [id, expected] of [
    [waiting, '> ready'],
    [working, 'esc to interrupt'],
  ]) {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await tmux('capture-pane', '-p', '-t', id)).stdout.includes(expected)) {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(ready, `window ${id} should contain its prompt`);
  }

  const log = join(root, 'calls');
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  await writeFile(join(root, 'tmux'), `#!/bin/sh\nprintf 'call\\n' >> ${quote(log)}\nexec ${quote(realTmux)} "$@"\n`, {
    mode: 0o700,
  });
  process.env.PATH = `${root}:${previousPath ?? ''}`;
  process.env.VAMPIRE_TMUX_SOCKET_NAME = socket;
  const workspace = (id: string, terminalId: string) => ({
    id,
    state: 'running' as const,
    terminals: [{ id: terminalId, index: 0, state: 'running' as const, foregroundProcess: foregroundCommand }],
  });
  const targets = Array.from({ length: 18 }, (_, index) => workspace(String(index), index % 2 ? working : waiting));
  const states = await readWorkspaceAgentStates(targets);
  for (let index = 0; index < targets.length; index += 1) {
    assert.equal(states.get(String(index)), index % 2 ? 'working' : 'waiting');
  }
  assert.equal((await readFile(log, 'utf8')).trim().split('\n').length, 2, '18 windows should use two tmux processes');

  const recovered = await readWorkspaceAgentStates([
    workspace('before', waiting),
    workspace('gone', '@999999'),
    workspace('after', working),
  ]);
  assert.equal(recovered.get('before'), 'waiting');
  assert.equal(recovered.get('gone'), null);
  assert.equal(recovered.get('after'), 'working');
});
