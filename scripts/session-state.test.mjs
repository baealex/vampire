import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { findSessionConnection, SESSION_STATE_VERSION } from '../src/lib/server/session-state.mjs';

test('finds the terminal and workspace registered for a session ID', async (t) => {
	const directory = await mkdtemp(join(tmpdir(), 'vampire-session-state-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const file = join(directory, 'sessions.json');
	const id = 'e272a1ce-550a-48a6-8d4a-5ef1cef1b46';
	await writeFile(file, JSON.stringify({
		version: SESSION_STATE_VERSION,
		sessions: [{ id, tmuxSession: 'vampire-e272a1ce', cwd: '/tmp/workspace' }]
	}));

	assert.deepEqual(await findSessionConnection(id, file), {
		tmuxSession: 'vampire-e272a1ce',
		cwd: '/tmp/workspace'
	});
	assert.equal(await findSessionConnection('47b7cc7d-b47e-4ab7-a1ee-f462eb779c46', file), undefined);
});

test('does not trust malformed session state', async (t) => {
	const directory = await mkdtemp(join(tmpdir(), 'vampire-session-state-invalid-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const file = join(directory, 'sessions.json');
	await writeFile(file, JSON.stringify({ version: SESSION_STATE_VERSION, sessions: [{ id: 'broken' }] }));

	assert.equal(await findSessionConnection('broken', file), undefined);
});
