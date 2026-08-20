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
	assert.equal(stored.workspacePreferences, undefined);
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

test('preserves managed worktree identity without changing legacy sessions', async (t) => {
	const directory = await mkdtemp(join(tmpdir(), 'vampire-session-store-worktree-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const file = join(directory, 'sessions.json');
	await writeFile(file, JSON.stringify({
		version: SESSION_STATE_VERSION,
		sessions: [{
			id: 'worktree-workspace',
			tmuxSession: 'vampire-worktree',
			cwd: '/tmp/state/worktrees/fix-login',
			repositoryPath: '/tmp/project',
			workspaceLabel: 'Fix login',
			worktreeBranch: 'vampire/fix-login-01234567',
			createdAt: 1
		}, {
			id: 'legacy-workspace',
			tmuxSession: 'vampire-legacy',
			cwd: '/tmp/legacy',
			createdAt: 2
		}]
	}));

	const [worktree, legacy] = (await readSessionStore(file)).sessions;
	assert.equal(worktree.repositoryPath, '/tmp/project');
	assert.equal(worktree.workspaceKind, 'worktree');
	assert.equal(worktree.workspaceLabel, 'Fix login');
	assert.equal(worktree.worktreeBranch, 'vampire/fix-login-01234567');
	assert.equal(legacy.repositoryPath, undefined);
	assert.equal(legacy.workspaceKind, undefined);
	assert.equal(legacy.workspaceLabel, undefined);
	assert.equal(legacy.worktreeBranch, undefined);
});

test('normalizes shared workspace order preferences without changing the state version', async (t) => {
	const directory = await mkdtemp(join(tmpdir(), 'vampire-session-store-preferences-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const file = join(directory, 'sessions.json');
	await writeFile(file, JSON.stringify({
		version: SESSION_STATE_VERSION,
		sessions: [],
		workspacePreferences: {
			sessionOrderMode: 'manual',
			manualSessionOrder: ['workspace-2', 'workspace-1', 'workspace-2']
		}
	}));

	assert.deepEqual((await readSessionStore(file)).workspacePreferences, {
		sessionOrderMode: 'manual',
		manualSessionOrder: ['workspace-2', 'workspace-1']
	});

	await writeFile(file, JSON.stringify({
		version: SESSION_STATE_VERSION,
		sessions: [],
		workspacePreferences: { sessionOrderMode: 'manual', manualSessionOrder: [42] }
	}));
	await assert.rejects(
		() => readSessionStore(file),
		/Vampire session registry is unreadable/
	);
});
