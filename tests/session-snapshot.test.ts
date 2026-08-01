import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { listManagedSessions } from '../src/lib/server/session-registry.ts';
import { SESSION_STATE_VERSION } from '../src/lib/server/session-store.ts';

test('exposes only explicit favorite commands and migrates legacy workspaces to an empty list', async (t) => {
	const directory = await mkdtemp(join(tmpdir(), 'vampire-session-snapshot-'));
	const previousStateDirectory = process.env.VAMPIRE_STATE_DIR;
	process.env.VAMPIRE_STATE_DIR = directory;
	t.after(async () => {
		if (previousStateDirectory === undefined) delete process.env.VAMPIRE_STATE_DIR;
		else process.env.VAMPIRE_STATE_DIR = previousStateDirectory;
		await rm(directory, { recursive: true, force: true });
	});

	const stateFile = join(directory, 'sessions.json');
	const baseSession = {
		id: 'favorite-workspace',
		tmuxSession: 'vampire-favorite-snapshot-test',
		cwd: tmpdir(),
		createdAt: 1,
		lastActiveAt: 1,
		note: ''
	};
	await writeFile(stateFile, JSON.stringify({ version: SESSION_STATE_VERSION, sessions: [baseSession] }));
	assert.deepEqual((await listManagedSessions())[0]?.favoriteCommands, []);

	await writeFile(stateFile, JSON.stringify({
		version: SESSION_STATE_VERSION,
		sessions: [{ ...baseSession, favoriteCommands: ['pnpm dev'] }]
	}));
	assert.deepEqual((await listManagedSessions())[0]?.favoriteCommands, ['pnpm dev']);
});
