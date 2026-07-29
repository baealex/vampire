import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '..');
const source = await readFile(resolve(root, 'src/lib/session/view.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
	compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
}).outputText;
const view = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

function session(lastOutputAt, id = 'workspace-1', state = 'running') {
	return {
		id,
		cwd: '/tmp/workspace-1',
		createdAt: 1,
		lastActiveAt: 1,
		lastOutputAt,
		notePreview: '',
		state,
		attachedClients: 0,
		foregroundProcess: null
	};
}

function activity(id, activeUntil, seenThroughAt) {
	return new Map([[id, { activeUntil, seenThroughAt }]]);
}

test('does not infer active output from a recent timestamp alone', () => {
	const current = session(Date.now());
	assert.equal(view.sessionActivityState(current), 'review');
});

test('derives active, review, and idle from output and observation timestamps', () => {
	const current = session(2_000);
	assert.equal(view.sessionActivityState(current, activity(current.id, 3_000, 0), 2_500), 'active');
	assert.equal(view.sessionActivityState(current, activity(current.id, 2_500, 0), 2_500), 'review');
	assert.equal(view.sessionActivityState(current, activity(current.id, 2_500, 2_000), 2_500), 'idle');
});

test('places active sessions above review sessions', () => {
	const states = ['active', 'review', 'idle', 'ended'];
	assert.deepEqual(
		states.sort((left, right) => view.sessionActivityPriority(left) - view.sessionActivityPriority(right)),
		['active', 'review', 'idle', 'ended']
	);
});

test('does not mark output covered by the observation watermark for review', () => {
	const current = session(2_000);
	assert.equal(view.sessionActivityState(current, activity(current.id, 0, 2_500), 3_000), 'idle');
	assert.equal(view.sessionActivityState({ ...current, lastOutputAt: 3_000 }, activity(current.id, 0, 2_500), 3_500), 'review');
});

test('does not invent a shell label for a missing session', () => {
	assert.equal(view.sessionProcess({ ...session(null), state: 'missing' }), null);
	assert.deepEqual(view.sessionProcess(session(null)), { kind: 'shell', label: 'shell' });
});

test('groups activity states without reordering sessions inside a state', () => {
	const sessions = [
		session(1_000, 'idle-a'),
		session(2_000, 'review-a'),
		session(3_000, 'active-a'),
		session(4_000, 'idle-b')
	];
	const records = new Map([
		['idle-a', { activeUntil: 0, seenThroughAt: 1_000 }],
		['review-a', { activeUntil: 0, seenThroughAt: 0 }],
		['active-a', { activeUntil: Date.now() + 10_000, seenThroughAt: 0 }],
		['idle-b', { activeUntil: 0, seenThroughAt: 4_000 }]
	]);
	assert.deepEqual(
		view.buildActivityOrder(sessions, ['idle-a', 'review-a', 'active-a', 'idle-b'], records),
		['active-a', 'review-a', 'idle-a', 'idle-b']
	);
});

test('keeps the previous order inside each activity group', () => {
	const sessions = [
		session(1_000, 'active-a'),
		session(2_000, 'active-b'),
		session(3_000, 'review-a'),
		session(4_000, 'review-b')
	];
	const records = new Map([
		['active-a', { activeUntil: Date.now() + 10_000, seenThroughAt: 0 }],
		['active-b', { activeUntil: Date.now() + 10_000, seenThroughAt: 0 }],
		['review-a', { activeUntil: 0, seenThroughAt: 0 }],
		['review-b', { activeUntil: 0, seenThroughAt: 0 }]
	]);
	assert.deepEqual(
		view.buildActivityOrder(sessions, ['review-b', 'active-b', 'review-a', 'active-a'], records),
		['active-b', 'active-a', 'review-b', 'review-a']
	);
});
