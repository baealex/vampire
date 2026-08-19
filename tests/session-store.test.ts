import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
	findSessionConnection,
	readSessionStore,
	SESSION_STATE_VERSION
} from '../src/lib/server/session-store.ts';

test('finds the terminal and workspace registered for a session ID', async (t) => {
	const directory = await mkdtemp(join(tmpdir(), 'vampire-session-state-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const file = join(directory, 'sessions.json');
	const id = 'e272a1ce-550a-48a6-8d4a-5ef1cef1b46';
	await writeFile(file, JSON.stringify({
		version: SESSION_STATE_VERSION,
		sessions: [{ id, tmuxSession: 'vampire-e272a1ce', cwd: '/tmp/workspace', createdAt: 1 }]
	}));

	assert.deepEqual(await findSessionConnection(id, file), {
		tmuxSession: 'vampire-e272a1ce',
		cwd: '/tmp/workspace'
	});
	const stored = await readSessionStore(file);
	assert.deepEqual(stored.sessions[0]?.launchProfiles, []);
	assert.equal(stored.sessions[0]?.defaultLaunchProfileId, null);
	assert.equal(stored.sessions[0]?.autoStartDefaultProfile, false);
	assert.equal(await findSessionConnection('47b7cc7d-b47e-4ab7-a1ee-f462eb779c46', file), undefined);
});

test('does not trust malformed session state', async (t) => {
	const directory = await mkdtemp(join(tmpdir(), 'vampire-session-state-invalid-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const file = join(directory, 'sessions.json');
	await writeFile(file, JSON.stringify({ version: SESSION_STATE_VERSION, sessions: [{ id: 'broken' }] }));

	assert.equal(await findSessionConnection('broken', file), undefined);
});

test('migrates legacy sessions without inventing command favorites', async (t) => {
	const directory = await mkdtemp(join(tmpdir(), 'vampire-session-store-favorites-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const file = join(directory, 'sessions.json');
	const session = {
		id: 'favorite-workspace',
		tmuxSession: 'vampire-favorite-store-test',
		cwd: tmpdir(),
		createdAt: 1,
		lastActiveAt: 1,
		note: ''
	};

	await writeFile(file, JSON.stringify({ version: SESSION_STATE_VERSION, sessions: [session] }));
	assert.deepEqual((await readSessionStore(file)).sessions[0]?.favoriteCommands, []);

	await writeFile(file, JSON.stringify({
		version: SESSION_STATE_VERSION,
		sessions: [{ ...session, favoriteCommands: ['pnpm dev'] }]
	}));
	assert.deepEqual((await readSessionStore(file)).sessions[0]?.favoriteCommands, ['pnpm dev']);
});

test('normalizes workspace launch profiles and keeps a valid default', async (t) => {
	const directory = await mkdtemp(join(tmpdir(), 'vampire-session-store-launch-profiles-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const file = join(directory, 'sessions.json');
	await writeFile(file, JSON.stringify({
		version: SESSION_STATE_VERSION,
		sessions: [{
			id: 'launch-profiles',
			tmuxSession: 'vampire-launch-profiles',
			cwd: tmpdir(),
			createdAt: 1,
			launchProfiles: [
				{ id: 'codex', name: ' Codex ', command: ' codex ' },
				{ id: 'broken', name: 'Broken\nProfile', command: 'ignored' }
			],
			defaultLaunchProfileId: 'codex',
			autoStartDefaultProfile: true
		}]
	}));

	const session = (await readSessionStore(file)).sessions[0]!;
	assert.deepEqual(session.launchProfiles, [{ id: 'codex', name: 'Codex', command: 'codex' }]);
	assert.equal(session.defaultLaunchProfileId, 'codex');
	assert.equal(session.autoStartDefaultProfile, true);
});
