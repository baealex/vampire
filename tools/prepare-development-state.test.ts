import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, '..');
const tool = join(repositoryRoot, 'tools', 'prepare-development-state.ts');

test('development state preparation requires explicit source and target paths', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'vampire-development-tool-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const target = join(root, 'target');
  await mkdir(source);
  await writeFile(join(source, 'sessions.json'), '{"version":1,"workspaces":[]}\n');

  await assert.rejects(run(process.execPath, [tool, '--source', source], { cwd: repositoryRoot }), /Command failed/);
  await assert.rejects(readFile(target), { code: 'ENOENT' });
});

test('development state preparation creates a fresh copy through the CLI', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'vampire-development-tool-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const target = join(root, 'target');
  await mkdir(source);
  await writeFile(join(source, 'sessions.json'), '{"version":1,"workspaces":[]}\n');

  const result = await run(process.execPath, [tool, '--', '--source', source, '--target', target], {
    cwd: repositoryRoot,
  });

  assert.match(result.stdout, /Prepared development state/);
  assert.match(result.stdout, /State layout version: 1/);
  await assert.rejects(readFile(join(target, 'sessions.json')), { code: 'ENOENT' });
  assert.match(await readFile(join(target, 'registry.json'), 'utf8'), /"workspaces": \[\]/);
});
