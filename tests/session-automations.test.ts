import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
	createManagedSessionAutomation,
	deleteManagedSessionAutomation,
	dispatchManagedSessionAutomation,
	listDueManagedSessionAutomations,
	listManagedSessionAutomations,
	setManagedSessionAutomationEnabled
} from '../src/lib/server/session-automations.ts';
import { readSessionStore, SESSION_STATE_VERSION } from '../src/lib/server/session-store.ts';

async function createStoredSession(t: test.TestContext) {
	const directory = await mkdtemp(join(tmpdir(), 'vampire-automations-'));
	const previousStateDirectory = process.env.VAMPIRE_STATE_DIR;
	process.env.VAMPIRE_STATE_DIR = directory;
	t.after(async () => {
		if (previousStateDirectory === undefined) delete process.env.VAMPIRE_STATE_DIR;
		else process.env.VAMPIRE_STATE_DIR = previousStateDirectory;
		await rm(directory, { recursive: true, force: true });
	});
	await writeFile(join(directory, 'sessions.json'), JSON.stringify({
		version: SESSION_STATE_VERSION,
		sessions: [{
			id: 'session-1',
			tmuxSession: 'vampire-session-1',
			cwd: tmpdir(),
			createdAt: 1,
			lastActiveAt: 1
		}]
	}));
}

test('a one-time automation stays queued until the agent is ready, then submits once', async (t) => {
	await createStoredSession(t);
	const now = Date.UTC(2026, 7, 20, 9, 0, 0);
	const automation = await createManagedSessionAutomation('session-1', {
		name: 'Review the work',
		prompt: 'Review the current work and list the next steps.',
		schedule: { type: 'once', runAt: now }
	}, now);

	assert.equal((await listDueManagedSessionAutomations(now)).length, 1);
	assert.equal(await dispatchManagedSessionAutomation(
		'session-1',
		automation.id,
		now,
		async () => undefined
	), 'not-ready');
	assert.equal((await listManagedSessionAutomations('session-1'))[0]?.enabled, true);

	const submissions: string[] = [];
	assert.equal(await dispatchManagedSessionAutomation(
		'session-1',
		automation.id,
		now,
		async (_session, current) => async () => { submissions.push(current.prompt); }
	), 'submitted');
	assert.deepEqual(submissions, ['Review the current work and list the next steps.']);

	const [saved] = await listManagedSessionAutomations('session-1');
	assert.equal(saved?.enabled, false);
	assert.equal(saved?.nextRunAt, null);
	assert.equal(saved?.lastRunAt, now);
	assert.equal(saved?.lastOutcome, 'submitted');
	assert.deepEqual(await listDueManagedSessionAutomations(now + 1), []);
});

test('a recurring automation coalesces missed intervals and never catches up repeatedly', async (t) => {
	await createStoredSession(t);
	const startAt = Date.UTC(2026, 7, 20, 9, 0, 0);
	const intervalMs = 60_000;
	const automation = await createManagedSessionAutomation('session-1', {
		name: 'Check tests',
		prompt: 'Check the test run and handle the next useful step.',
		schedule: { type: 'interval', intervalMs, startAt }
	}, startAt - intervalMs);
	const attemptedAt = startAt + intervalMs * 3 + 15_000;

	assert.equal(await dispatchManagedSessionAutomation(
		'session-1',
		automation.id,
		attemptedAt,
		async () => async () => undefined
	), 'submitted');

	const [saved] = await listManagedSessionAutomations('session-1');
	assert.equal(saved?.enabled, true);
	assert.equal(saved?.nextRunAt, startAt + intervalMs * 4);
	assert.equal((await listDueManagedSessionAutomations(attemptedAt)).length, 0);
});

test('pause, resume, delete, and failed delivery remain durable', async (t) => {
	await createStoredSession(t);
	const now = Date.UTC(2026, 7, 20, 9, 0, 0);
	const automation = await createManagedSessionAutomation('session-1', {
		name: 'Prepare update',
		prompt: 'Prepare an update.',
		schedule: { type: 'once', runAt: now }
	}, now);

	assert.equal((await setManagedSessionAutomationEnabled('session-1', automation.id, false, now + 1)).enabled, false);
	assert.deepEqual(await listDueManagedSessionAutomations(now + 1), []);
	assert.equal((await setManagedSessionAutomationEnabled('session-1', automation.id, true, now + 2)).enabled, true);

	assert.equal(await dispatchManagedSessionAutomation(
		'session-1',
		automation.id,
		now + 2,
		async () => async () => { throw new Error('tmux unavailable'); }
	), 'failed');
	const [failed] = await listManagedSessionAutomations('session-1');
	assert.equal(failed?.enabled, false);
	assert.equal(failed?.lastOutcome, 'failed');
	assert.match(failed?.lastError ?? '', /tmux unavailable/);

	await deleteManagedSessionAutomation('session-1', automation.id);
	assert.deepEqual(await listManagedSessionAutomations('session-1'), []);
	assert.deepEqual((await readSessionStore()).sessions[0]?.automations, []);
});
