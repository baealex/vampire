import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { TestContext } from 'node:test';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  createGitWorktree,
  GitWorktreeError,
  removeManagedGitWorktree,
} from '~/lib/features/repository/server/git-worktree.ts';

const run = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Vampire Test',
      GIT_AUTHOR_EMAIL: 'vampire@example.test',
      GIT_COMMITTER_NAME: 'Vampire Test',
      GIT_COMMITTER_EMAIL: 'vampire@example.test',
    },
  });
  return stdout;
}

async function createRepository(t: TestContext, withCommit = true): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'vampire-worktree-source-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await git(directory, 'init', '--quiet');
  if (withCommit) {
    await writeFile(join(directory, 'app.txt'), 'committed\n');
    await git(directory, 'add', 'app.txt');
    await git(directory, 'commit', '--quiet', '-m', 'initial');
  }
  return directory;
}

test('creates an isolated branch and worktree from HEAD without copying uncommitted changes', async (t) => {
  const source = await createRepository(t);
  const managedRoot = await mkdtemp(join(tmpdir(), 'vampire-managed-worktrees-'));
  t.after(() => rm(managedRoot, { recursive: true, force: true }));
  await writeFile(join(source, 'app.txt'), 'uncommitted\n');

  const created = await createGitWorktree(source, 'Fix Login UI', {
    managedRoot,
    id: '01234567-89ab-cdef-0123-456789abcdef',
  });
  t.after(() => git(source, 'worktree', 'remove', '--force', created.cwd).catch(() => ''));

  assert.equal(created.label, 'Fix Login UI');
  assert.equal(created.branch, 'fix-login-ui-01234567');
  assert.equal(created.sourceRoot, await realpath(source));
  assert.equal(basename(dirname(created.cwd)), '01234567-89ab-cdef-0123-456789abcdef');
  assert.equal(basename(created.cwd), basename(source));
  assert.equal((await git(created.cwd, 'branch', '--show-current')).trim(), created.branch);
  assert.equal(await readFile(created.cwd + '/app.txt', 'utf8'), 'committed\n');
  assert.equal(await readFile(source + '/app.txt', 'utf8'), 'uncommitted\n');
});

test('uses a safe fallback slug for non-Latin task names', async (t) => {
  const source = await createRepository(t);
  const managedRoot = await mkdtemp(join(tmpdir(), 'vampire-managed-worktrees-'));
  t.after(() => rm(managedRoot, { recursive: true, force: true }));

  const created = await createGitWorktree(source, '로그인 수정', {
    managedRoot,
    id: 'fedcba98-7654-3210-fedc-ba9876543210',
  });
  t.after(() => git(source, 'worktree', 'remove', '--force', created.cwd).catch(() => ''));

  assert.equal(created.label, '로그인 수정');
  assert.equal(created.branch, 'task-fedcba98');
  assert.equal(basename(dirname(created.cwd)), 'fedcba98-7654-3210-fedc-ba9876543210');
  assert.equal(basename(created.cwd), basename(source));
});

test('rejects invalid task names and repositories without a commit', async (t) => {
  const source = await createRepository(t, false);
  const managedRoot = await mkdtemp(join(tmpdir(), 'vampire-managed-worktrees-'));
  t.after(() => rm(managedRoot, { recursive: true, force: true }));

  await assert.rejects(
    () => createGitWorktree(source, '   ', { managedRoot }),
    (error) => error instanceof GitWorktreeError && error.reason === 'invalid-name'
  );
  await assert.rejects(
    () => createGitWorktree(source, 'First task', { managedRoot }),
    (error) => error instanceof GitWorktreeError && error.reason === 'no-head'
  );
});

test('never deletes a branch that already owns the generated worktree name', async (t) => {
  const source = await createRepository(t);
  const managedRoot = await mkdtemp(join(tmpdir(), 'vampire-managed-worktrees-'));
  t.after(() => rm(managedRoot, { recursive: true, force: true }));
  const branch = 'fix-login-01234567';
  await git(source, 'branch', branch, 'HEAD');
  const expectedCommit = (await git(source, 'rev-parse', branch)).trim();

  await assert.rejects(
    () =>
      createGitWorktree(source, 'Fix login', {
        managedRoot,
        id: '01234567-89ab-cdef-0123-456789abcdef',
      }),
    (error) => error instanceof GitWorktreeError && error.reason === 'command-failed'
  );
  assert.equal((await git(source, 'rev-parse', branch)).trim(), expectedCommit);
});

test('removes a managed working copy and registration while preserving its branch', async (t) => {
  const source = await createRepository(t);
  const managedRoot = await mkdtemp(join(tmpdir(), 'vampire-managed-worktrees-'));
  t.after(() => rm(managedRoot, { recursive: true, force: true }));
  const id = '01234567-89ab-cdef-0123-456789abcdef';
  const created = await createGitWorktree(source, 'Disposable work', { managedRoot, id });
  await writeFile(join(created.cwd, 'uncommitted.txt'), 'remove me\n');

  await removeManagedGitWorktree(
    {
      id,
      cwd: created.cwd,
      repositoryPath: source,
    },
    { managedRoot }
  );

  assert.equal((await git(source, 'branch', '--list', created.branch)).trim(), created.branch);
  assert.doesNotMatch(await git(source, 'worktree', 'list', '--porcelain'), new RegExp(created.cwd));
  await assert.rejects(() => realpath(created.workspaceDirectory), { code: 'ENOENT' });
});

test('clears a stale registration after the managed working directory was deleted externally', async (t) => {
  const source = await createRepository(t);
  const managedRoot = await mkdtemp(join(tmpdir(), 'vampire-managed-worktrees-'));
  t.after(() => rm(managedRoot, { recursive: true, force: true }));
  const id = 'fedcba98-7654-3210-fedc-ba9876543210';
  const created = await createGitWorktree(source, 'Externally removed', { managedRoot, id });
  await rm(created.cwd, { recursive: true, force: true });

  await removeManagedGitWorktree(
    {
      id,
      cwd: created.cwd,
      repositoryPath: source,
    },
    { managedRoot }
  );

  assert.equal((await git(source, 'branch', '--list', created.branch)).trim(), created.branch);
  assert.doesNotMatch(await git(source, 'worktree', 'list', '--porcelain'), new RegExp(created.cwd));
  await assert.rejects(() => realpath(created.workspaceDirectory), { code: 'ENOENT' });
});

test('refuses to remove a path outside the matching managed workspace ID', async (t) => {
  const source = await createRepository(t);
  const managedRoot = await mkdtemp(join(tmpdir(), 'vampire-managed-worktrees-'));
  t.after(() => rm(managedRoot, { recursive: true, force: true }));

  await assert.rejects(
    () =>
      removeManagedGitWorktree(
        {
          id: '01234567-89ab-cdef-0123-456789abcdef',
          cwd: source,
          repositoryPath: source,
        },
        { managedRoot }
      ),
    (error) => error instanceof GitWorktreeError && error.reason === 'invalid-location'
  );
  assert.equal(await readFile(join(source, 'app.txt'), 'utf8'), 'committed\n');
});
