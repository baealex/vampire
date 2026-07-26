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

test('shows the application after status without waiting for session refresh', async () => {
	const source = await readFile(resolve(root, 'src/lib/app/workspace-connection-state.svelte.ts'), 'utf8');
	const checkingComplete = source.indexOf('this.checking = false');
	const refreshSessions = source.indexOf('void refreshSessions()');

	assert.ok(checkingComplete >= 0, 'connection startup must finish the checking state');
	assert.ok(refreshSessions >= 0, 'connection startup must refresh sessions after status');
	assert.ok(checkingComplete < refreshSessions, 'a slow session refresh must not block the startup screen');
});
