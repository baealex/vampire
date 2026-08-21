import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import {
	migrateManagedSessionNotes,
	queueManagedSessionNoteSummary
} from '../src/lib/server/session-automations.ts';
import { managedSessionNotePath } from '../src/lib/server/session-note-file.ts';
import {
	findManagedSessionNote,
	updateManagedSessionNote
} from '../src/lib/server/session-registry.ts';
import { readSessionStateFile, readSessionStore, SESSION_STATE_VERSION } from '../src/lib/server/session-store.ts';

async function useTemporaryStateDirectory(t: test.TestContext, prefix: string): Promise<{
	directory: string;
	stateDirectory: string;
}> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	const stateDirectory = join(directory, 'state');
	const previousStateDirectory = process.env.VAMPIRE_STATE_DIR;
	process.env.VAMPIRE_STATE_DIR = stateDirectory;
	t.after(async () => {
		if (previousStateDirectory === undefined) delete process.env.VAMPIRE_STATE_DIR;
		else process.env.VAMPIRE_STATE_DIR = previousStateDirectory;
		await rm(directory, { recursive: true, force: true });
	});
	await mkdir(stateDirectory, { recursive: true });
	return { directory, stateDirectory };
}

test('the note summary action exposes the live state-directory note without a JSON mirror', async (t) => {
	const { directory, stateDirectory } = await useTemporaryStateDirectory(t, 'vampire-note-automation-');
	const workspace = join(directory, 'workspace');
	await mkdir(workspace);
	await writeFile(join(stateDirectory, 'sessions.json'), JSON.stringify({
		version: SESSION_STATE_VERSION,
		sessions: [{
			id: 'session-1',
			tmuxSession: 'vampire-session-1',
			cwd: workspace,
			createdAt: 1,
			lastActiveAt: 1
		}]
	}));

	const notePath = managedSessionNotePath('session-1');
	assert.equal(notePath, join(stateDirectory, 'session-1.note.md'));
	await writeFile(notePath, 'Existing context\n');
	const queued = await queueManagedSessionNoteSummary('session-1', 1_000);
	assert.equal(queued.notePath, notePath);
	assert.equal(await readFile(notePath, 'utf8'), 'Existing context\n');
	assert.match(queued.automation.prompt, /Done/);
	assert.match(queued.automation.prompt, /Next/);
	assert.match(queued.automation.prompt, /Infer the document language from the user's language and the conversation context/);
	assert.match(queued.automation.prompt, new RegExp(notePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
	await writeFile(notePath, '## Done\n\nBuilt the automation queue.\n\n## Next\n\nVerify the UI.\n');
	assert.equal(
		await findManagedSessionNote('session-1'),
		'## Done\n\nBuilt the automation queue.\n\n## Next\n\nVerify the UI.'
	);
	await unlink(notePath);
	assert.equal(await findManagedSessionNote('session-1'), '');
});

test('startup migration copies every legacy JSON note once and removes the legacy mirror', async (t) => {
	const { stateDirectory } = await useTemporaryStateDirectory(t, 'vampire-note-migration-');
	await writeFile(managedSessionNotePath('workspace-one'), 'Stale file from before rollback\n');
	await writeFile(join(stateDirectory, 'sessions.json'), JSON.stringify({
		version: SESSION_STATE_VERSION,
		sessions: [{
			id: 'workspace-one',
			tmuxSession: 'vampire-one',
			cwd: '/tmp/one',
			createdAt: 1,
			note: 'Legacy one'
		}, {
			id: 'workspace-two',
			tmuxSession: 'vampire-two',
			cwd: '/tmp/two',
			createdAt: 2,
			note: 'Legacy two'
		}]
	}));

	assert.equal(await migrateManagedSessionNotes(), 2);
	assert.equal(await readFile(managedSessionNotePath('workspace-one'), 'utf8'), 'Stale file from before rollback\n');
	assert.equal(await readFile(managedSessionNotePath('workspace-two'), 'utf8'), 'Legacy two\n');
	assert.equal((await readSessionStore()).sessions.length, 2);
	assert.equal(await migrateManagedSessionNotes(), 0);

	await writeFile(managedSessionNotePath('workspace-two'), 'Latest from the file\n');
	assert.deepEqual((await readSessionStore()).sessions[1]?.automations, []);
});

test('a legacy JSON note blocks migration when its note file cannot be created', async (t) => {
	const { stateDirectory } = await useTemporaryStateDirectory(t, 'vampire-note-fallback-');
	await writeFile(join(stateDirectory, 'sessions.json'), JSON.stringify({
		version: SESSION_STATE_VERSION,
		sessions: [{
			id: 'blocked-note',
			tmuxSession: 'vampire-blocked-note',
			cwd: '/tmp/blocked-note',
			createdAt: 1,
			note: 'Legacy value'
		}]
	}));
	await mkdir(managedSessionNotePath('blocked-note'));

	await assert.rejects(
		migrateManagedSessionNotes(),
		/not a regular file/
	);
	await assert.rejects(
		updateManagedSessionNote('blocked-note', 'Still editable'),
		/not a regular file/
	);
	const raw = await readSessionStateFile() as { sessions: Array<{ note?: string }> };
	assert.equal(raw.sessions[0]?.note, 'Legacy value');
});

test('legacy session identifiers cannot escape the Vampire state directory', async (t) => {
	const { stateDirectory } = await useTemporaryStateDirectory(t, 'vampire-note-path-');
	const path = managedSessionNotePath('../../outside');
	assert.equal(dirname(path), stateDirectory);
	assert.match(basename(path), /^[a-f0-9]{64}\.note\.md$/);
});
