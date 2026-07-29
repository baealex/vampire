import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');

test('runs the root page in runes mode for shared reactive state', async () => {
	const source = await readFile(resolve(root, 'src/routes/+page.svelte'), 'utf8');
	assert.match(source, /\$props\(\)/);
	assert.doesNotMatch(source, /\bexport\s+let\b/);
});

test('opens the realtime workspace stream after status without blocking startup', async () => {
	const source = await readFile(resolve(root, 'src/lib/app/workspace-connection-state.svelte.ts'), 'utf8');
	const checkingComplete = source.indexOf('this.checking = false');
	const workspaceStream = source.indexOf('this.#startWorkspaceStream(this.#connectionOptions, runVersion)');

	assert.ok(checkingComplete >= 0, 'connection startup must finish the checking state');
	assert.ok(workspaceStream >= 0, 'connection startup must open the workspace stream after status');
	assert.ok(checkingComplete < workspaceStream, 'a slow workspace stream must not block the startup screen');
	assert.match(source, /\/ws\/workspace/);
	assert.match(source, /sessions-snapshot/);
});

test('loads the code editor only after a text file is opened', async () => {
	const source = await readFile(resolve(root, 'src/lib/repository/RepositoryViewer.svelte'), 'utf8');
	assert.match(source, /import\('\.\/RepositoryCodeEditor\.svelte'\)/);
	assert.doesNotMatch(source, /import\s+RepositoryCodeEditor\s+from/);
});
