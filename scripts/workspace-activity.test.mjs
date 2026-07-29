import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileSessionActivity } from './workspace-websocket.mjs';

function session(overrides = {}) {
	return {
		id: 'workspace-1',
		tmuxSession: 'vampire-workspace-1',
		cwd: '/tmp/workspace-1',
		createdAt: 1,
		lastActiveAt: 1,
		notePreview: '',
		state: 'running',
		lastOutputAt: 1_000,
		attachedClients: 0,
		foregroundProcess: null,
		...overrides
	};
}

test('reconciles only newer tmux output activity', () => {
	const current = session();
	const result = reconcileSessionActivity(new Map([[current.id, current]]), [
		{ name: current.tmuxSession, lastOutputAt: 2_000 }
	]);

	assert.deepEqual(result.updates, [{ id: current.id, changes: { lastOutputAt: 2_000 } }]);
	assert.equal(result.sessions.get(current.id).lastOutputAt, 2_000);

	const unchanged = reconcileSessionActivity(result.sessions, [
		{ name: current.tmuxSession, lastOutputAt: 2_000 }
	]);
	assert.deepEqual(unchanged.updates, []);
});

test('marks a managed session ended when tmux disappears', () => {
	const current = session({
		attachedClients: 1,
		foregroundProcess: { kind: 'command', label: 'node' }
	});
	const result = reconcileSessionActivity(new Map([[current.id, current]]), []);

	assert.deepEqual(result.updates, [{
		id: current.id,
		changes: {
			state: 'missing',
			lastOutputAt: null,
			attachedClients: 0,
			foregroundProcess: null
		}
	}]);
});

test('recognizes a previously missing tmux session without inventing activity', () => {
	const current = session({ state: 'missing', lastOutputAt: null });
	const result = reconcileSessionActivity(new Map([[current.id, current]]), [
		{ name: current.tmuxSession, lastOutputAt: null }
	]);

	assert.deepEqual(result.updates, [{ id: current.id, changes: { state: 'running' } }]);
});
