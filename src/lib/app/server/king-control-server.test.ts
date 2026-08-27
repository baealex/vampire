import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { ensureManagedKingWorkspace } from '~/lib/features/workspace/server/king-workspace.server.ts';
import type { KingControlRequest } from '~/lib/shared/contracts/king-workflow.ts';
import { installKingControlServer } from './king-control-server.server.ts';

const execFile = promisify(execFileCallback);

test('does not materialize the managed King package before the workspace is created', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vampire-king-lazy-control-'));
  const previousStateDirectory = process.env.VAMPIRE_STATE_DIR;
  process.env.VAMPIRE_STATE_DIR = directory;
  const close = await installKingControlServer();
  t.after(async () => {
    close();
    if (previousStateDirectory === undefined) delete process.env.VAMPIRE_STATE_DIR;
    else process.env.VAMPIRE_STATE_DIR = previousStateDirectory;
    await rm(directory, { recursive: true, force: true });
  });

  await assert.rejects(access(join(directory, 'king')), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
});

test('generated King package exchanges one structured request over the private Unix socket', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vampire-king-control-'));
  const previousStateDirectory = process.env.VAMPIRE_STATE_DIR;
  process.env.VAMPIRE_STATE_DIR = directory;
  const prepared = await ensureManagedKingWorkspace();
  let received: KingControlRequest | undefined;
  const close = await installKingControlServer(async (request) => {
    received = request;
    return { id: request.id, ok: true, data: { ready: true, command: request.command } };
  });
  t.after(async () => {
    close();
    if (previousStateDirectory === undefined) delete process.env.VAMPIRE_STATE_DIR;
    else process.env.VAMPIRE_STATE_DIR = previousStateDirectory;
    await rm(directory, { recursive: true, force: true });
  });

  const { stdout, stderr } = await execFile('npm', ['run', '-s', 'king', '--', 'status'], { cwd: prepared.cwd });
  assert.equal(stderr, '');
  const response = JSON.parse(stdout) as { ok: boolean; data: { ready: boolean; command: string } };
  assert.equal(response.ok, true);
  assert.equal(response.data.ready, true);
  assert.equal(response.data.command, 'status');
  assert.equal(received?.command, 'status');
});

test('creates a real version-pinned Run through the generated CLI and control server', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vkc-real-'));
  const previousStateDirectory = process.env.VAMPIRE_STATE_DIR;
  process.env.VAMPIRE_STATE_DIR = directory;
  const prepared = await ensureManagedKingWorkspace();
  const close = await installKingControlServer();
  t.after(async () => {
    close();
    if (previousStateDirectory === undefined) delete process.env.VAMPIRE_STATE_DIR;
    else process.env.VAMPIRE_STATE_DIR = previousStateDirectory;
    await rm(directory, { recursive: true, force: true });
  });

  const inputPath = join(prepared.cwd, 'run-input.json');
  await writeFile(inputPath, JSON.stringify({ title: 'Orchestrate release', objective: 'Ship the release safely.' }));
  const createdOutput = await execFile('npm', ['run', '-s', 'king', '--', 'run', 'create', '--input', inputPath], {
    cwd: prepared.cwd,
  });
  const created = JSON.parse(createdOutput.stdout) as {
    ok: boolean;
    data: { id: string; contractRevision: string; status: string };
  };
  assert.equal(created.ok, true);
  assert.equal(created.data.status, 'active');
  assert.match(created.data.contractRevision, new RegExp(`^${prepared.bootstrapVersion}-[0-9a-f]{12}$`));

  const statusOutput = await execFile('npm', ['run', '-s', 'king', '--', 'status'], { cwd: prepared.cwd });
  const status = JSON.parse(statusOutput.stdout) as { ok: boolean; data: { activeRuns: number } };
  assert.deepEqual(status, { ok: true, data: { ...status.data, activeRuns: 1 } });
});
