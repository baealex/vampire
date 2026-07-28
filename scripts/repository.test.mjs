import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import {
	readRepositoryDiff,
	readRepositorySnapshot,
	readWorkspaceDirectory,
	readWorkspaceImage,
	readWorkspaceImageMetadata,
	readWorkspaceFile,
	createWorkspaceDirectory,
	deleteWorkspaceEntry,
	writeWorkspaceFile,
	RepositoryReadError
} from '../src/lib/server/repository.mjs';

const run = promisify(execFile);

async function git(cwd, ...args) {
	await run('git', args, {
		cwd,
		env: {
			...process.env,
			GIT_AUTHOR_NAME: 'Vampire Test',
			GIT_AUTHOR_EMAIL: 'vampire@example.test',
			GIT_COMMITTER_NAME: 'Vampire Test',
			GIT_COMMITTER_EMAIL: 'vampire@example.test'
		}
	});
}

async function createRepository(t) {
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
	assert.deepEqual((await readWorkspaceDirectory(directory, 'src')).files, ['src/app.js']);
	assert.deepEqual((await readWorkspaceDirectory(directory, 'node_modules')).files, ['node_modules/package.js']);
	assert.deepEqual(first.changes.map(({ path, status }) => ({ path, status })), [
		{ path: 'notes.md', status: '??' },
		{ path: 'src/app.js', status: ' M' }
	]);

	await writeFile(join(directory, 'src', 'new.js'), 'export {};\n');
	await rm(join(directory, 'notes.md'));
	const second = await readRepositorySnapshot(directory);
	assert.deepEqual(second.files, ['.env', '.gitignore', 'ignored.log']);
	assert.deepEqual((await readWorkspaceDirectory(directory, 'src')).files, ['src/app.js', 'src/new.js']);
	assert.deepEqual(second.changes.map(({ path, status }) => ({ path, status })), [
		{ path: 'src/app.js', status: ' M' },
		{ path: 'src/new.js', status: '??' }
	]);
});

test('returns staged, working tree, and untracked diff sections', async (t) => {
	const directory = await createRepository(t);
	await writeFile(join(directory, 'src', 'app.js'), 'const value = 2;\n');
	await git(directory, 'add', 'src/app.js');
	await writeFile(join(directory, 'src', 'app.js'), 'const value = 3;\n');

	const tracked = await readRepositoryDiff(directory, 'src/app.js');
	assert.deepEqual(tracked.sections.map((section) => section.kind), ['staged', 'working']);
	assert.match(tracked.sections[0].patch, /\+const value = 2;/);
	assert.match(tracked.sections[1].patch, /-const value = 2;/);
	assert.match(tracked.sections[1].patch, /\+const value = 3;/);

	await writeFile(join(directory, 'notes.md'), '# New note\n');
	const untracked = await readRepositoryDiff(directory, 'notes.md');
	assert.deepEqual(untracked.sections.map((section) => section.kind), ['untracked']);
	assert.match(untracked.sections[0].patch, /\+# New note/);
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

	const updated = await writeWorkspaceFile(directory, 'logs/company.log', 'first line\nsecond line\n', {
		expectedVersion: created.version
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
	const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
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
