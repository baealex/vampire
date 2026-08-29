import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import type { TestContext } from 'node:test';
import {
  readRepositoryDiff,
  readRepositoryDirectory,
  readRepositorySummary,
  readRepositorySnapshot,
  readWorkspaceDirectory,
  readWorkspaceImage,
  readWorkspaceImageMetadata,
  readWorkspaceFile,
  createWorkspaceDirectory,
  deleteWorkspaceEntry,
  discardRepositoryChange,
  moveWorkspaceEntry,
  uploadWorkspaceFile,
  writeWorkspaceFile,
  RepositoryReadError,
} from '~/lib/features/repository/server/repository.server.ts';

const run = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', args, {
    cwd,
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

async function createRepository(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'vampire-repository-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await git(directory, 'init', '--quiet');
  await mkdir(join(directory, 'src'));
  await writeFile(join(directory, '.gitignore'), 'ignored.log\n.env\nbuild/\nnode_modules/\n');
  await writeFile(join(directory, 'src', 'app.js'), 'const value = 1;\n');
  await git(directory, 'add', '.');
  await git(directory, 'commit', '--quiet', '-m', 'initial');
  return directory;
}

test('lists workspace files including Git-ignored entries and reflects structure changes', async (t) => {
  const directory = await createRepository(t);
  await mkdir(join(directory, 'build'));
  await mkdir(join(directory, 'node_modules'));
  await writeFile(join(directory, 'build', 'output.js'), 'generated\n');
  await writeFile(join(directory, 'node_modules', 'package.js'), 'dependency\n');
  await writeFile(join(directory, 'src', 'app.js'), 'const value = 2;\n');
  await writeFile(join(directory, 'notes.md'), '# Notes\n');
  await writeFile(join(directory, 'ignored.log'), 'hidden\n');
  await writeFile(join(directory, '.env'), 'SECRET=value\n');

  const first = await readRepositorySnapshot(directory);
  assert.equal(first.isGitRepository, true);
  assert.deepEqual(first.files, ['.env', '.gitignore', 'ignored.log', 'notes.md']);
  assert.deepEqual(first.directories, ['build', 'node_modules', 'src']);
  assert.deepEqual([...first.ignored].sort(), ['.env', 'build', 'ignored.log', 'node_modules']);
  assert.deepEqual((await readWorkspaceDirectory(directory, 'src')).files, ['src/app.js']);
  assert.deepEqual((await readWorkspaceDirectory(directory, 'node_modules')).files, ['node_modules/package.js']);
  assert.deepEqual((await readRepositoryDirectory(directory, 'node_modules')).ignored, ['node_modules/package.js']);
  assert.deepEqual(
    first.changes.map(({ path, status }) => ({ path, status })),
    [
      { path: 'notes.md', status: '??' },
      { path: 'src/app.js', status: ' M' },
    ]
  );

  await writeFile(join(directory, 'src', 'new.js'), 'export {};\n');
  await rm(join(directory, 'notes.md'));
  const second = await readRepositorySnapshot(directory);
  assert.deepEqual(second.files, ['.env', '.gitignore', 'ignored.log']);
  assert.deepEqual((await readWorkspaceDirectory(directory, 'src')).files, ['src/app.js', 'src/new.js']);
  assert.deepEqual(
    second.changes.map(({ path, status }) => ({ path, status })),
    [
      { path: 'src/app.js', status: ' M' },
      { path: 'src/new.js', status: '??' },
    ]
  );
});

test('reports local branches, recent commits, upstream distance, and linked worktrees', async (t) => {
  const directory = await createRepository(t);
  const branch = (await git(directory, 'branch', '--show-current')).trim();
  const remote = await mkdtemp(join(tmpdir(), 'vampire-remote-'));
  const worktreeParent = await mkdtemp(join(tmpdir(), 'vampire-worktrees-'));
  const linkedWorktree = join(worktreeParent, 'review-auth');
  t.after(() => rm(remote, { recursive: true, force: true }));
  t.after(() => rm(worktreeParent, { recursive: true, force: true }));

  await git(remote, 'init', '--quiet', '--bare');
  await git(directory, 'remote', 'add', 'origin', remote);
  await git(directory, 'push', '--quiet', '--set-upstream', 'origin', branch);
  await writeFile(join(directory, 'second.txt'), 'second\n');
  await git(directory, 'add', 'second.txt');
  await git(directory, 'commit', '--quiet', '-m', 'second commit');
  await git(directory, 'worktree', 'add', '--quiet', '-b', 'review-auth', linkedWorktree, 'HEAD~1');

  const snapshot = await readRepositorySnapshot(directory);
  const canonicalDirectory = await realpath(directory);
  const canonicalLinkedWorktree = await realpath(linkedWorktree);
  assert.equal(snapshot.git?.branch, branch);
  assert.equal(snapshot.git?.detached, false);
  assert.deepEqual(snapshot.git?.upstream, { name: `origin/${branch}`, ahead: 1, behind: 0 });
  assert.deepEqual(
    snapshot.git?.commits.map(({ subject }) => subject),
    ['second commit', 'initial']
  );
  assert.equal(snapshot.git?.commits[0]?.authorName, 'Vampire Test');
  assert.match(snapshot.git?.commits[0]?.shortHash ?? '', /^[a-f0-9]+$/);
  assert.deepEqual(
    snapshot.git?.branches.map(({ name, current, worktreePath }) => ({
      name,
      current,
      worktreePath,
    })),
    [
      { name: branch, current: true, worktreePath: canonicalDirectory },
      { name: 'review-auth', current: false, worktreePath: canonicalLinkedWorktree },
    ]
  );
  assert.equal(snapshot.git?.worktrees.length, 2);
  assert.deepEqual(
    snapshot.git?.worktrees.map(({ name, branch: worktreeBranch, current }) => ({
      name,
      branch: worktreeBranch,
      current,
    })),
    [
      { name: directory.split('/').pop(), branch, current: true },
      { name: 'review-auth', branch: 'review-auth', current: false },
    ]
  );
});

test('reports an unborn branch without inventing commits or an upstream', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vampire-unborn-details-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await git(directory, 'init', '--quiet');

  const snapshot = await readRepositorySnapshot(directory);
  assert.equal(snapshot.git?.branch, (await git(directory, 'branch', '--show-current')).trim());
  assert.equal(snapshot.git?.detached, false);
  assert.equal(snapshot.git?.upstream, undefined);
  const canonicalDirectory = await realpath(directory);
  assert.deepEqual(snapshot.git?.branches, [
    {
      name: (await git(directory, 'branch', '--show-current')).trim(),
      current: true,
      worktreePath: canonicalDirectory,
    },
  ]);
  assert.deepEqual(snapshot.git?.commits, []);
});

test('counts the main and linked Git worktrees without scanning their files', async (t) => {
  const directory = await createRepository(t);
  const worktreeParent = await mkdtemp(join(tmpdir(), 'vampire-worktrees-'));
  const linkedWorktree = join(worktreeParent, 'linked');
  t.after(() => rm(worktreeParent, { recursive: true, force: true }));

  assert.equal((await readRepositorySummary(directory)).worktreeCount, 1);
  await git(directory, 'worktree', 'add', '--quiet', '-b', 'worktree-count-test', linkedWorktree);
  assert.equal((await readRepositorySummary(directory)).worktreeCount, 2);
  assert.equal((await readRepositorySummary(linkedWorktree)).worktreeCount, 2);

  await git(directory, 'worktree', 'remove', '--force', linkedWorktree);
  assert.equal((await readRepositorySummary(directory)).worktreeCount, 1);
});

test('reports added and deleted lines for tracked and untracked changes', async (t) => {
  const directory = await createRepository(t);
  await writeFile(join(directory, 'src', 'app.js'), 'const value = 2;\nconst other = true;\n');
  await writeFile(join(directory, 'notes.md'), '# New note\nSecond line\n');

  const snapshot = await readRepositorySnapshot(directory);
  assert.deepEqual(snapshot.changeStats, { additions: 4, deletions: 1 });
});

test('does not count a deleted worktree that only remains in Git metadata', async (t) => {
  const directory = await createRepository(t);
  const worktreeParent = await mkdtemp(join(tmpdir(), 'vampire-worktrees-'));
  const linkedWorktree = join(worktreeParent, 'linked');
  t.after(() => rm(worktreeParent, { recursive: true, force: true }));

  await git(directory, 'worktree', 'add', '--quiet', '-b', 'deleted-worktree-test', linkedWorktree);
  assert.equal((await readRepositorySummary(directory)).worktreeCount, 2);
  await rm(linkedWorktree, { recursive: true, force: true });
  assert.equal((await readRepositorySummary(directory)).worktreeCount, 1);
});

test('returns staged, working tree, and untracked diff sections', async (t) => {
  const directory = await createRepository(t);
  await writeFile(join(directory, 'src', 'app.js'), 'const value = 2;\n');
  await git(directory, 'add', 'src/app.js');
  await writeFile(join(directory, 'src', 'app.js'), 'const value = 3;\n');

  const tracked = await readRepositoryDiff(directory, 'src/app.js');
  assert.deepEqual(
    tracked.sections.map((section) => section.kind),
    ['staged', 'working']
  );
  assert.match(tracked.sections[0].patch, /\+const value = 2;/);
  assert.match(tracked.sections[1].patch, /-const value = 2;/);
  assert.match(tracked.sections[1].patch, /\+const value = 3;/);

  await writeFile(join(directory, 'notes.md'), '# New note\n');
  const untracked = await readRepositoryDiff(directory, 'notes.md');
  assert.deepEqual(
    untracked.sections.map((section) => section.kind),
    ['untracked']
  );
  assert.match(untracked.sections[0].patch, /\+# New note/);
});

test('discards tracked, staged, renamed, and untracked Git changes', async (t) => {
  const directory = await createRepository(t);
  await writeFile(join(directory, 'src', 'app.js'), 'const value = 2;\n');
  await git(directory, 'add', 'src/app.js');
  await writeFile(join(directory, 'src', 'app.js'), 'const value = 3;\n');
  await writeFile(join(directory, 'notes.md'), '# Untracked\n');

  let snapshot = await readRepositorySnapshot(directory);
  const tracked = snapshot.changes.find((change) => change.path === 'src/app.js');
  const untracked = snapshot.changes.find((change) => change.path === 'notes.md');
  assert.ok(tracked);
  assert.ok(untracked);
  assert.deepEqual(await discardRepositoryChange(directory, tracked.path, tracked), {
    path: 'src/app.js',
    untracked: false,
  });
  assert.equal(await readFile(join(directory, 'src', 'app.js'), 'utf8'), 'const value = 1;\n');
  assert.deepEqual(await discardRepositoryChange(directory, untracked.path, untracked), {
    path: 'notes.md',
    untracked: true,
  });
  await assert.rejects(
    () => stat(join(directory, 'notes.md')),
    (error) => (error as NodeJS.ErrnoException).code === 'ENOENT'
  );

  await git(directory, 'mv', 'src/app.js', 'src/main.js');
  snapshot = await readRepositorySnapshot(directory);
  const renamed = snapshot.changes.find((change) => change.path === 'src/main.js');
  assert.ok(renamed);
  assert.equal(renamed.previousPath, 'src/app.js');
  await discardRepositoryChange(directory, renamed.path, renamed);
  assert.equal(await readFile(join(directory, 'src', 'app.js'), 'utf8'), 'const value = 1;\n');
  await assert.rejects(
    () => stat(join(directory, 'src', 'main.js')),
    (error) => (error as NodeJS.ErrnoException).code === 'ENOENT'
  );

  await writeFile(join(directory, 'src', 'new.js'), 'export {};\n');
  await git(directory, 'add', 'src/new.js');
  snapshot = await readRepositorySnapshot(directory);
  const added = snapshot.changes.find((change) => change.path === 'src/new.js');
  assert.ok(added);
  await discardRepositoryChange(directory, added.path, added);
  await assert.rejects(
    () => stat(join(directory, 'src', 'new.js')),
    (error) => (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
  assert.deepEqual((await readRepositorySnapshot(directory)).changes, []);
});

test('refuses stale or non-change discard requests', async (t) => {
  const directory = await createRepository(t);
  await writeFile(join(directory, '.gitignore'), 'changed\n');
  const working = (await readRepositorySnapshot(directory)).changes.find((change) => change.path === '.gitignore');
  assert.ok(working);
  await git(directory, 'add', '.gitignore');

  await assert.rejects(
    () => discardRepositoryChange(directory, working.path, working),
    (error) => error instanceof RepositoryReadError && error.reason === 'conflict'
  );
  assert.equal(await readFile(join(directory, '.gitignore'), 'utf8'), 'changed\n');
  await assert.rejects(
    () => discardRepositoryChange(directory, 'src/app.js'),
    (error) => error instanceof RepositoryReadError && error.reason === 'not-found'
  );
});

test('discards a staged file before the repository has its first commit', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vampire-unborn-repository-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await git(directory, 'init', '--quiet');
  await writeFile(join(directory, 'first.txt'), 'first content\n');
  await git(directory, 'add', 'first.txt');
  const change = (await readRepositorySnapshot(directory)).changes.find((candidate) => candidate.path === 'first.txt');
  assert.ok(change);

  await discardRepositoryChange(directory, change.path, change);
  await assert.rejects(
    () => stat(join(directory, 'first.txt')),
    (error) => (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
  assert.deepEqual((await readRepositorySnapshot(directory)).changes, []);
});

test('reads UTF-8 files but rejects traversal, binary data, and escaping symlinks', async (t) => {
  const directory = await createRepository(t);
  const outsideDirectory = await mkdtemp(join(tmpdir(), 'vampire-outside-'));
  t.after(() => rm(outsideDirectory, { recursive: true, force: true }));
  await writeFile(join(outsideDirectory, 'secret.txt'), 'secret\n');
  await symlink(join(outsideDirectory, 'secret.txt'), join(directory, 'outside-link'));
  await writeFile(join(directory, 'binary.dat'), Buffer.from([0, 1, 2, 3]));

  const file = await readWorkspaceFile(directory, 'src/app.js');
  assert.equal(file.content, 'const value = 1;\n');
  assert.equal(file.path, 'src/app.js');
  assert.match(file.version, /^[a-f0-9]{64}$/);

  await assert.rejects(
    () => readWorkspaceFile(directory, '../secret.txt'),
    (error) => error instanceof RepositoryReadError && error.reason === 'invalid-path'
  );
  await assert.rejects(
    () => readWorkspaceFile(directory, 'outside-link'),
    (error) => error instanceof RepositoryReadError && error.reason === 'invalid-path'
  );
  await assert.rejects(
    () => deleteWorkspaceEntry(directory, 'outside-link', 'file'),
    (error) => error instanceof RepositoryReadError && error.reason === 'invalid-path'
  );
  await assert.rejects(
    () => readWorkspaceFile(directory, 'binary.dat'),
    (error) => error instanceof RepositoryReadError && error.reason === 'unsupported-file'
  );
});

test('creates and updates text files without overwriting newer changes', async (t) => {
  const directory = await createRepository(t);
  const createdDirectory = await createWorkspaceDirectory(directory, 'logs');
  assert.equal(createdDirectory.path, 'logs');
  await assert.rejects(
    () => createWorkspaceDirectory(directory, 'logs'),
    (error) => error instanceof RepositoryReadError && error.reason === 'conflict'
  );
  const created = await writeWorkspaceFile(directory, 'logs/company.log', 'first line\n', { createOnly: true });
  assert.equal(created.path, 'logs/company.log');
  assert.equal(created.content, 'first line\n');
  const nested = await writeWorkspaceFile(directory, 'generated/reports/today.md', '# Today\n', { createOnly: true });
  assert.equal(nested.path, 'generated/reports/today.md');
  assert.equal(nested.content, '# Today\n');
  const nestedDirectory = await createWorkspaceDirectory(directory, 'archives/2026/july');
  assert.equal(nestedDirectory.path, 'archives/2026/july');
  await mkdir(join(directory, 'linked-target'));
  await symlink(join(directory, 'linked-target'), join(directory, 'linked-parent'));
  const linkedFile = await writeWorkspaceFile(directory, 'linked-parent/generated/note.txt', 'linked\n', {
    createOnly: true,
  });
  assert.equal(linkedFile.path, 'linked-parent/generated/note.txt');
  assert.equal(await readFile(join(directory, 'linked-target', 'generated', 'note.txt'), 'utf8'), 'linked\n');

  const competingCreates = await Promise.allSettled([
    writeWorkspaceFile(directory, 'logs/concurrent.log', 'first\n', { createOnly: true }),
    writeWorkspaceFile(directory, 'logs/concurrent.log', 'second\n', { createOnly: true }),
  ]);
  assert.equal(competingCreates.filter(({ status }) => status === 'fulfilled').length, 1);
  const rejectedCreate = competingCreates.find(({ status }) => status === 'rejected');
  assert.equal(rejectedCreate?.status, 'rejected');
  assert.equal(rejectedCreate.reason instanceof RepositoryReadError && rejectedCreate.reason.reason, 'conflict');

  const updated = await writeWorkspaceFile(directory, 'logs/company.log', 'first line\nsecond line\n', {
    expectedVersion: created.version,
  });
  assert.equal(updated.content, 'first line\nsecond line\n');

  await assert.rejects(
    () => writeWorkspaceFile(directory, 'logs/company.log', 'stale\n', { expectedVersion: created.version }),
    (error) => error instanceof RepositoryReadError && error.reason === 'conflict'
  );
  await assert.rejects(
    () => writeWorkspaceFile(directory, 'logs/company.log', 'duplicate\n', { createOnly: true }),
    (error) => error instanceof RepositoryReadError && error.reason === 'conflict'
  );

  const snapshot = await readRepositorySnapshot(directory);
  assert.ok(snapshot.directories.includes('logs'));
  assert.ok((await readWorkspaceDirectory(directory, 'logs')).files.includes('logs/company.log'));
});

test('uploads binary files without replacing existing entries by default', async (t) => {
  const directory = await createRepository(t);
  const firstBytes = Buffer.from([0, 1, 2, 3, 255]);
  const created = await uploadWorkspaceFile(directory, 'assets/archive.bin', firstBytes);
  assert.deepEqual(created, { path: 'assets/archive.bin', size: firstBytes.length, renamed: false });
  assert.deepEqual(await readFile(join(directory, created.path)), firstBytes);

  await assert.rejects(
    () => uploadWorkspaceFile(directory, 'assets/archive.bin', Buffer.from('replacement')),
    (error) => error instanceof RepositoryReadError && error.reason === 'conflict'
  );
  assert.deepEqual(await readFile(join(directory, created.path)), firstBytes);
});

test('renames or replaces upload conflicts only when explicitly requested', async (t) => {
  const directory = await createRepository(t);
  await uploadWorkspaceFile(directory, 'assets/archive.bin', Buffer.from('original'));

  const renamedUploads = await Promise.all([
    uploadWorkspaceFile(directory, 'assets/archive.bin', Buffer.from('first copy'), { conflict: 'rename' }),
    uploadWorkspaceFile(directory, 'assets/archive.bin', Buffer.from('second copy'), { conflict: 'rename' }),
  ]);
  assert.deepEqual(renamedUploads.map(({ path }) => path).sort(), ['assets/archive (1).bin', 'assets/archive (2).bin']);
  assert.ok(renamedUploads.every(({ renamed }) => renamed));

  const replaced = await uploadWorkspaceFile(directory, 'assets/archive.bin', Buffer.from('replacement'), {
    conflict: 'overwrite',
  });
  assert.deepEqual(replaced, { path: 'assets/archive.bin', size: 11, renamed: false });
  assert.equal(await readFile(join(directory, replaced.path), 'utf8'), 'replacement');
});

test('keeps uploads inside the workspace and protects git metadata', async (t) => {
  const directory = await createRepository(t);
  const outsideDirectory = await mkdtemp(join(tmpdir(), 'vampire-upload-outside-'));
  t.after(() => rm(outsideDirectory, { recursive: true, force: true }));
  await symlink(outsideDirectory, join(directory, 'outside-link'));

  for (const path of ['../secret.bin', '.git/config', '.GIT/config', 'nested/.git/index', 'outside-link/secret.bin']) {
    await assert.rejects(
      () => uploadWorkspaceFile(directory, path, Buffer.from('secret')),
      (error) => error instanceof RepositoryReadError && error.reason === 'invalid-path'
    );
  }

  let remainingChunks = 12;
  const streamed = await uploadWorkspaceFile(
    directory,
    'large.bin',
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (remainingChunks-- > 0) controller.enqueue(Buffer.alloc(1024 * 1024, remainingChunks));
        else controller.close();
      },
    })
  );
  assert.equal(streamed.size, 12 * 1024 * 1024);
  assert.equal((await stat(join(directory, streamed.path))).size, streamed.size);

  let firstChunk = true;
  await assert.rejects(
    () =>
      uploadWorkspaceFile(
        directory,
        'interrupted.bin',
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (firstChunk) {
              firstChunk = false;
              controller.enqueue(Buffer.from('partial'));
              return;
            }
            controller.error(new Error('stream interrupted'));
          },
        })
      ),
    (error) => error instanceof RepositoryReadError && error.reason === 'command-failed'
  );
  await assert.rejects(
    () => stat(join(directory, 'interrupted.bin')),
    (error) => (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
  assert.equal(
    (await readdir(directory)).some((name) => name.startsWith('.vampire-upload-')),
    false
  );
});

test('moves workspace files and folders without overwriting existing entries', async (t) => {
  const directory = await createRepository(t);
  await writeFile(join(directory, 'move-me.txt'), 'source file\n', 'utf8');
  await writeFile(join(directory, 'src', 'move-me.txt'), 'existing file\n', 'utf8');

  await assert.rejects(
    () => moveWorkspaceEntry(directory, 'move-me.txt', 'file', 'src'),
    (error) => error instanceof RepositoryReadError && error.reason === 'conflict'
  );
  assert.equal(await readFile(join(directory, 'move-me.txt'), 'utf8'), 'source file\n');
  assert.equal(await readFile(join(directory, 'src', 'move-me.txt'), 'utf8'), 'existing file\n');

  const renamed = await moveWorkspaceEntry(directory, 'move-me.txt', 'file', 'src', { conflict: 'rename' });
  assert.deepEqual(renamed, {
    fromPath: 'move-me.txt',
    path: 'src/move-me (1).txt',
    kind: 'file',
    renamed: true,
  });
  assert.equal(await readFile(join(directory, renamed.path), 'utf8'), 'source file\n');
  await assert.rejects(
    () => stat(join(directory, 'move-me.txt')),
    (error) => (error as NodeJS.ErrnoException).code === 'ENOENT'
  );

  await mkdir(join(directory, 'docs', 'guides'), { recursive: true });
  await writeFile(join(directory, 'docs', 'guides', 'intro.md'), '# Intro\n', 'utf8');
  const movedDirectory = await moveWorkspaceEntry(directory, 'docs', 'directory', 'src');
  assert.equal(movedDirectory.path, 'src/docs');
  assert.equal(await readFile(join(directory, 'src', 'docs', 'guides', 'intro.md'), 'utf8'), '# Intro\n');
});

test('rejects workspace moves into descendants, git metadata, and linked directories outside the workspace', async (t) => {
  const directory = await createRepository(t);
  const outsideDirectory = await mkdtemp(join(tmpdir(), 'vampire-move-outside-'));
  t.after(() => rm(outsideDirectory, { recursive: true, force: true }));
  await mkdir(join(directory, 'src', 'nested'));
  await symlink(outsideDirectory, join(directory, 'outside-link'));

  for (const operation of [
    () => moveWorkspaceEntry(directory, 'src', 'directory', 'src/nested'),
    () => moveWorkspaceEntry(directory, '.git/config', 'file', ''),
    () => moveWorkspaceEntry(directory, 'src/app.js', 'file', '.GIT'),
    () => moveWorkspaceEntry(directory, 'src/app.js', 'file', 'outside-link'),
  ]) {
    await assert.rejects(operation, (error) => error instanceof RepositoryReadError && error.reason === 'invalid-path');
  }
  assert.equal(await readFile(join(directory, 'src', 'app.js'), 'utf8'), 'const value = 1;\n');
});

test('does not create directories through linked parents outside the workspace', async (t) => {
  const directory = await createRepository(t);
  const outsideDirectory = await mkdtemp(join(tmpdir(), 'vampire-outside-'));
  t.after(() => rm(outsideDirectory, { recursive: true, force: true }));
  await symlink(outsideDirectory, join(directory, 'outside-link'));

  await assert.rejects(
    () => writeWorkspaceFile(directory, 'outside-link/file-parent/note.txt', 'secret\n', { createOnly: true }),
    (error) => error instanceof RepositoryReadError && error.reason === 'invalid-path'
  );
  await assert.rejects(
    () => stat(join(outsideDirectory, 'file-parent')),
    (error) => (error as NodeJS.ErrnoException)?.code === 'ENOENT'
  );

  await assert.rejects(
    () => createWorkspaceDirectory(directory, 'outside-link/folder-parent/new-folder'),
    (error) => error instanceof RepositoryReadError && error.reason === 'invalid-path'
  );
  await assert.rejects(
    () => stat(join(outsideDirectory, 'folder-parent')),
    (error) => (error as NodeJS.ErrnoException)?.code === 'ENOENT'
  );
});

test('deletes files and folders without leaving the workspace', async (t) => {
  const directory = await createRepository(t);
  await createWorkspaceDirectory(directory, 'logs');
  await writeWorkspaceFile(directory, 'logs/company.log', 'first line\n', { createOnly: true });
  await writeWorkspaceFile(directory, 'logs/today.log', 'today\n', { createOnly: true });

  const deletedFile = await deleteWorkspaceEntry(directory, 'logs/company.log', 'file');
  assert.equal(deletedFile.path, 'logs/company.log');
  await assert.rejects(
    () => readWorkspaceFile(directory, 'logs/company.log'),
    (error) => error instanceof RepositoryReadError && error.reason === 'not-found'
  );

  const deletedDirectory = await deleteWorkspaceEntry(directory, 'logs', 'directory');
  assert.equal(deletedDirectory.path, 'logs');
  await assert.rejects(
    () => readWorkspaceFile(directory, 'logs/today.log'),
    (error) => error instanceof RepositoryReadError && error.reason === 'not-found'
  );
  await assert.rejects(
    () => deleteWorkspaceEntry(directory, '.', 'directory'),
    (error) => error instanceof RepositoryReadError && error.reason === 'invalid-path'
  );
});

test('serves supported workspace images by detected content type', async (t) => {
  const directory = await createRepository(t);
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
  );
  await writeFile(join(directory, 'preview.png'), png);
  await writeFile(join(directory, 'fake.png'), 'not an image');

  const image = await readWorkspaceImage(directory, 'preview.png');
  const metadata = await readWorkspaceImageMetadata(directory, 'preview.png');
  assert.equal(image.mimeType, 'image/png');
  assert.deepEqual(image.bytes, png);
  assert.match(image.version, /^[a-f0-9]{64}$/);
  assert.equal(metadata.mimeType, image.mimeType);
  assert.equal(metadata.size, image.size);
  assert.equal(metadata.version, image.version);

  await assert.rejects(
    () => readWorkspaceImage(directory, 'fake.png'),
    (error) => error instanceof RepositoryReadError && error.reason === 'unsupported-file'
  );
});
