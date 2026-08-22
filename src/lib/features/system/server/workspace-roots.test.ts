import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  listWorkspaceRoots,
  readWorkspaceDirectory,
  resolveWorkspaceDirectory,
  WorkspaceRootError,
} from '~/lib/features/system/server/workspace-roots.ts';

function workspaceRoot(path: string) {
  return { id: 'root-1', label: 'Test root', path };
}

test('only resolves directories inside the configured root, including symlink escapes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'vampire-workspace-root-'));
  const outside = await mkdtemp(join(tmpdir(), 'vampire-workspace-outside-'));
  t.after(() =>
    Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })])
  );

  await mkdir(join(root, 'project'));
  await mkdir(join(outside, 'secret'));
  await symlink(join(outside, 'secret'), join(root, 'linked-outside'));
  const canonicalRoot = await realpath(root);
  const roots = [workspaceRoot(canonicalRoot)];

  const resolved = await resolveWorkspaceDirectory(join(canonicalRoot, 'project'), roots);
  assert.equal(resolved.path, join(canonicalRoot, 'project'));

  await assert.rejects(
    () => resolveWorkspaceDirectory(join(root, '..', basename(outside)), roots),
    (error) => error instanceof WorkspaceRootError && error.reason === 'outside-root'
  );
  await assert.rejects(
    () => resolveWorkspaceDirectory(join(canonicalRoot, 'missing'), roots),
    (error) => error instanceof WorkspaceRootError && error.reason === 'not-found'
  );
  await assert.rejects(
    () => resolveWorkspaceDirectory(join(canonicalRoot, 'linked-outside'), roots),
    (error) => error instanceof WorkspaceRootError && error.reason === 'outside-root'
  );
  await assert.rejects(
    () => resolveWorkspaceDirectory(join(outside, 'secret'), roots),
    (error) => error instanceof WorkspaceRootError && error.reason === 'outside-root'
  );
});

test('lists immediate real directories and never exposes files or linked directories', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'vampire-workspace-list-'));
  const outside = await mkdtemp(join(tmpdir(), 'vampire-workspace-list-outside-'));
  const previousRoots = process.env.VAMPIRE_WORKSPACE_ROOTS;
  t.after(async () => {
    if (previousRoots === undefined) delete process.env.VAMPIRE_WORKSPACE_ROOTS;
    else process.env.VAMPIRE_WORKSPACE_ROOTS = previousRoots;
    await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]);
  });

  process.env.VAMPIRE_WORKSPACE_ROOTS = root;
  await mkdir(join(root, 'zeta'));
  await mkdir(join(root, 'alpha'));
  await mkdir(join(root, '.hidden'));
  await mkdir(join(root, '.git'));
  await writeFile(join(root, 'README.md'), 'file\n');
  await mkdir(join(outside, 'secret'));
  await symlink(join(outside, 'secret'), join(root, 'linked-outside'));

  const roots = await listWorkspaceRoots();
  assert.deepEqual(
    roots.map(({ path }) => path),
    [await realpath(root)]
  );

  const canonicalRoot = await realpath(root);
  const listing = await readWorkspaceDirectory(canonicalRoot);
  assert.equal(listing.current?.path, canonicalRoot);
  assert.equal(listing.parentPath, null);
  assert.deepEqual(
    listing.directories.map(({ name }) => name),
    ['.hidden', 'alpha', 'zeta']
  );
  assert.equal(listing.truncated, false);
});
