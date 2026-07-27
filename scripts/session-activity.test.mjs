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

test('does not show live activity for a recent timestamp that has already been observed', () => {
	assert.equal(view.sessionActivityState(session(Date.now()), undefined, false), 'idle');
});

test('shows live activity only while output is active or recent unread output is arriving', () => {
	const current = session(Date.now());
	assert.equal(view.sessionActivityState(current, current.id, false), 'live');
	assert.equal(view.sessionActivityState(current, undefined, true), 'live');
	assert.equal(view.sessionActivityState(session(Date.now() - 11_000), undefined, true), 'review');
});

test('ignores delayed timestamps covered by the last observation', () => {
	assert.equal(view.sessionOutputBecameUnread(1_000, 2_000, 2_500, false), false);
	assert.equal(view.sessionOutputBecameUnread(1_000, 3_000, 2_500, false), true);
	assert.equal(view.sessionOutputBecameUnread(1_000, 3_000, 0, true), false);
});

test('does not invent a shell label for a missing session', () => {
	assert.equal(view.sessionProcess({ ...session(null), state: 'missing' }), null);
	assert.deepEqual(view.sessionProcess(session(null)), { kind: 'shell', label: 'shell' });
});

test('groups activity states without reordering sessions inside a state', () => {
	const sessions = [
		session(1_000, 'idle-a'),
		session(2_000, 'review-a'),
		session(3_000, 'live-a'),
		session(4_000, 'idle-b')
	];
	assert.deepEqual(
		view.sortSessions(sessions, 'activity', [], ['review-a', 'live-a', 'idle-a', 'idle-b'])
			.map(({ id }) => id),
		['review-a', 'live-a', 'idle-a', 'idle-b']
	);
	assert.deepEqual(
		view.sortSessions(sessions, 'activity', [], ['idle-a', 'review-a', 'live-a', 'idle-b'])
			.map(({ id }) => id),
		['idle-a', 'review-a', 'live-a', 'idle-b']
	);
});
