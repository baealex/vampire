import assert from 'node:assert/strict';
import test from 'node:test';
import {
	preserveLatestOutput,
	reconcileSessionActivity,
	stabilizeAgentStates
} from '../runtime/workspace-websocket.ts';
import type { AgentState } from '../src/lib/session/agent.ts';
import type { ManagedSession, SessionTerminal } from '../src/lib/session/types.ts';

function session(overrides: Partial<ManagedSession> = {}): ManagedSession {
	return {
		id: 'workspace-1',
		tmuxSession: 'vampire-workspace-1',
		cwd: '/tmp/workspace-1',
		createdAt: 1,
		lastActiveAt: 1,
		notePreview: '',
		favoriteCommands: [],
		state: 'running',
		lastOutputAt: 1_000,
		attachedClients: 0,
		foregroundProcess: null,
		terminals: [],
		agentState: null,
		isGitRepository: false,
		...overrides
	};
}

function terminal(id: string, index: number, lastOutputAt: number): SessionTerminal {
	return {
		id,
		index,
		name: index === 0 ? 'main' : 'server',
		active: index === 0,
		lastOutputAt,
		foregroundProcess: null,
		command: null,
		startedAt: null,
		state: 'running',
		exitCode: null
	};
}

test('reconciles only newer tmux output activity', () => {
	const current = session();
	const result = reconcileSessionActivity(new Map([[current.id, current]]), [
		{ name: current.tmuxSession, lastOutputAt: 2_000, mainLastOutputAt: null }
	]);

	assert.deepEqual(result.updates, [{ id: current.id, changes: { lastOutputAt: 2_000 } }]);
	assert.equal(result.sessions.get(current.id)!.lastOutputAt, 2_000);

	const unchanged = reconcileSessionActivity(result.sessions, [
		{ name: current.tmuxSession, lastOutputAt: 2_000, mainLastOutputAt: null }
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
			foregroundProcess: null,
			terminals: []
		}
	}]);
});

test('recognizes a previously missing tmux session without inventing activity', () => {
	const current = session({ state: 'missing', lastOutputAt: null });
	const result = reconcileSessionActivity(new Map([[current.id, current]]), [
		{ name: current.tmuxSession, lastOutputAt: null, mainLastOutputAt: null }
	]);

	assert.deepEqual(result.updates, [{ id: current.id, changes: { state: 'running' } }]);
});

test('uses main terminal activity for the workspace timestamp', () => {
	const current = session({
		terminals: [
			terminal('@0', 0, 1_000),
			terminal('@1', 1, 1_000)
		]
	});
	const result = reconcileSessionActivity(new Map([[current.id, current]]), [{
		name: current.tmuxSession,
		lastOutputAt: 3_000,
		mainLastOutputAt: 2_000
	}]);

	assert.deepEqual(result.updates, [{
		id: current.id,
		changes: {
			lastOutputAt: 2_000,
			terminals: [
				{ ...current.terminals[0], lastOutputAt: 2_000 },
				current.terminals[1]
			]
		}
	}]);
});

test('ignores tmux activity covered by a synthetic redraw watermark', () => {
	const current = session({
		terminals: [
			terminal('@0', 0, 1_000),
			terminal('@1', 1, 1_000)
		]
	});
	const result = reconcileSessionActivity(
		new Map([[current.id, current]]),
		[{ name: current.tmuxSession, lastOutputAt: 3_000, mainLastOutputAt: 3_000 }],
		new Map([[current.id, { lastOutputAt: 3_500, mainLastOutputAt: 3_500 }]])
	);

	assert.deepEqual(result.updates, []);
	assert.deepEqual(result.sessions.get(current.id), current);
});

test('preserves visible output times while accepting process changes after a synthetic redraw', () => {
	const current = session({
		terminals: [
			terminal('@0', 0, 1_000),
			terminal('@1', 1, 1_000)
		]
	});
	const refreshed: ManagedSession = {
		...current,
		lastOutputAt: 3_000,
		terminals: [
			{ ...current.terminals[0], lastOutputAt: 3_000 },
			{
				...current.terminals[1],
				name: 'sleep',
				lastOutputAt: 3_000,
				foregroundProcess: { kind: 'command', label: 'sleep' }
			}
		]
	};
	const result = preserveLatestOutput(
		new Map([[current.id, refreshed]]),
		new Map([[current.id, current]]),
		new Map([[current.id, { lastOutputAt: 3_500, mainLastOutputAt: 3_500 }]])
	);

	assert.equal(result.get(current.id)!.lastOutputAt, 1_000);
	assert.equal(result.get(current.id)!.terminals[0].lastOutputAt, 1_000);
	assert.equal(result.get(current.id)!.terminals[1].lastOutputAt, 3_000);
	assert.deepEqual(result.get(current.id)!.terminals[1].foregroundProcess, { kind: 'command', label: 'sleep' });
});

test('publishes inferred agent state alongside tmux activity', () => {
	const current = session({ agentState: null });
	const result = reconcileSessionActivity(
		new Map([[current.id, current]]),
		[{ name: current.tmuxSession, lastOutputAt: 1_000, mainLastOutputAt: 1_000 }],
		new Map(),
		new Map([[current.id, 'working']])
	);

	assert.deepEqual(result.updates, [{ id: current.id, changes: { agentState: 'working' } }]);
});

test('requires two quiet observations before moving a working agent to waiting', () => {
	const current = session({ agentState: 'working' });
	const sessions = new Map([[current.id, current]]);
	const detected = new Map<string, AgentState>([[current.id, 'waiting']]);
	const pending = new Map<string, { state: AgentState; count: number }>();

	assert.equal(stabilizeAgentStates(sessions, detected, pending).get(current.id), 'working');
	assert.equal(stabilizeAgentStates(sessions, detected, pending).get(current.id), 'waiting');
	assert.equal(pending.size, 0);
});
