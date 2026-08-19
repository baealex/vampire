import assert from 'node:assert/strict';
import test from 'node:test';
import {
	decodeTerminalClientMessage,
	decodeTerminalServerMessage,
	encodeTerminalClientMessage,
	encodeTerminalServerMessage
} from '../src/lib/terminal/protocol.ts';
import {
	decodeWorkspaceServerMessage,
	encodeWorkspaceServerMessage,
	type WorkspaceServerMessage
} from '../src/lib/app/workspace-protocol.ts';
import type { ManagedSession } from '../src/lib/session/types.ts';

function managedSession(overrides: Record<string, unknown> = {}): ManagedSession {
	return {
		id: 'session-1',
		tmuxSession: 'vampire-session-1',
		cwd: '/tmp/workspace',
		createdAt: 1,
		lastActiveAt: 2,
		notePreview: '',
		favoriteCommands: ['pnpm dev'],
		launchProfiles: [{ id: 'codex', name: 'Codex', command: 'codex' }],
		defaultLaunchProfileId: 'codex',
		autoStartDefaultProfile: false,
		state: 'running',
		lastOutputAt: 3,
		attachedClients: 1,
		foregroundProcess: { kind: 'command', label: 'codex' },
		terminals: [{
			id: '@0',
			index: 0,
			name: 'codex',
			active: true,
			lastOutputAt: 3,
			foregroundProcess: { kind: 'command', label: 'codex' },
			command: null,
			startedAt: null,
			state: 'running',
			exitCode: null
		}],
		agentState: null,
		isGitRepository: true,
		...overrides
	} as ManagedSession;
}

test('round-trips valid terminal client messages and rejects invalid sizes', () => {
	assert.deepEqual(decodeTerminalClientMessage(encodeTerminalClientMessage({ type: 'activate' })), { type: 'activate' });
	assert.deepEqual(
		decodeTerminalClientMessage(encodeTerminalClientMessage({ type: 'input', data: 'hello\n' })),
		{ type: 'input', data: 'hello\n' }
	);
	assert.deepEqual(
		decodeTerminalClientMessage(encodeTerminalClientMessage({
			type: 'submit',
			data: 'hello\nworld',
			bracketedPaste: true
		})),
		{ type: 'submit', data: 'hello\nworld', bracketedPaste: true }
	);
	assert.deepEqual(
		decodeTerminalClientMessage(encodeTerminalClientMessage({ type: 'resize', columns: 120, rows: 40 })),
		{ type: 'resize', columns: 120, rows: 40 }
	);
	assert.deepEqual(
		decodeTerminalClientMessage(encodeTerminalClientMessage({ type: 'resize', columns: 257, rows: 57 })),
		{ type: 'resize', columns: 257, rows: 57 }
	);
	assert.deepEqual(
		decodeTerminalClientMessage(encodeTerminalClientMessage({ type: 'load-history', lines: 500 })),
		{ type: 'load-history', lines: 500 }
	);
	assert.deepEqual(
		decodeTerminalClientMessage(encodeTerminalClientMessage({
			type: 'terminal-color',
			slot: 11,
			color: '#fbfafa'
		})),
		{ type: 'terminal-color', slot: 11, color: '#fbfafa' }
	);
	assert.equal(decodeTerminalClientMessage('{"type":"resize","columns":19,"rows":40}'), undefined);
	assert.equal(decodeTerminalClientMessage('{"type":"resize","columns":513,"rows":40}'), undefined);
	assert.equal(decodeTerminalClientMessage('{"type":"load-history","lines":0}'), undefined);
	assert.equal(decodeTerminalClientMessage('{"type":"load-history","lines":10001}'), undefined);
	assert.equal(decodeTerminalClientMessage('{"type":"input","data":12}'), undefined);
	assert.equal(decodeTerminalClientMessage('{"type":"submit","data":"hello"}'), undefined);
	assert.equal(decodeTerminalClientMessage('{"type":"submit","data":"hello","bracketedPaste":"yes"}'), undefined);
	assert.equal(decodeTerminalClientMessage('{"type":"terminal-color","slot":9,"color":"#fbfafa"}'), undefined);
	assert.equal(decodeTerminalClientMessage('{"type":"terminal-color","slot":11,"color":"red; kill-server"}'), undefined);
});

test('round-trips valid terminal server messages and rejects incomplete payloads', () => {
	assert.deepEqual(
		decodeTerminalServerMessage(encodeTerminalServerMessage({
			type: 'snapshot',
			data: 'screen',
			history: { loaded: 500, available: 1_200 }
		})),
		{ type: 'snapshot', data: 'screen', history: { loaded: 500, available: 1_200 } }
	);
	assert.deepEqual(
		decodeTerminalServerMessage(encodeTerminalServerMessage({ type: 'request-terminal-theme' })),
		{ type: 'request-terminal-theme' }
	);
	assert.deepEqual(
		decodeTerminalServerMessage(encodeTerminalServerMessage({ type: 'geometry', columns: 120, rows: 40 })),
		{ type: 'geometry', columns: 120, rows: 40 }
	);
	assert.deepEqual(
		decodeTerminalServerMessage(encodeTerminalServerMessage({ type: 'geometry', columns: 48, rows: 20, active: false })),
		{ type: 'geometry', columns: 48, rows: 20, active: false }
	);
	assert.deepEqual(
		decodeTerminalServerMessage(encodeTerminalServerMessage({ type: 'output', data: 'ready', activity: true, activityAt: 4_000 })),
		{ type: 'output', data: 'ready', activity: true, activityAt: 4_000 }
	);
	assert.deepEqual(
		decodeTerminalServerMessage(encodeTerminalServerMessage({ type: 'repository-status', changeCount: 2, worktreeCount: 1 })),
		{ type: 'repository-status', changeCount: 2, worktreeCount: 1 }
	);
	assert.equal(decodeTerminalServerMessage('{"type":"snapshot"}'), undefined);
	assert.equal(decodeTerminalServerMessage('{"type":"snapshot","data":"screen","history":{"loaded":6,"available":5}}'), undefined);
	assert.equal(decodeTerminalServerMessage('{"type":"geometry","columns":0,"rows":40}'), undefined);
	assert.equal(decodeTerminalServerMessage('{"type":"geometry","columns":120,"rows":40,"active":"yes"}'), undefined);
	assert.equal(decodeTerminalServerMessage('{"type":"output","data":"ready","activity":true,"activityAt":null}'), undefined);
	assert.equal(decodeTerminalServerMessage('{"type":"repository-status","changeCount":-1,"worktreeCount":1}'), undefined);
});

test('validates complete workspace messages before applying them to client state', () => {
	const snapshot: WorkspaceServerMessage = { type: 'sessions-snapshot', sessions: [managedSession()] };
	assert.deepEqual(decodeWorkspaceServerMessage(encodeWorkspaceServerMessage(snapshot)), snapshot);
	assert.deepEqual(
		decodeWorkspaceServerMessage(encodeWorkspaceServerMessage({
			type: 'session-updated',
			id: 'session-1',
			changes: { state: 'missing', lastOutputAt: null, foregroundProcess: null, agentState: null }
		})),
		{
			type: 'session-updated',
			id: 'session-1',
			changes: { state: 'missing', lastOutputAt: null, foregroundProcess: null, agentState: null }
		}
	);
	assert.equal(decodeWorkspaceServerMessage(JSON.stringify({
		type: 'sessions-snapshot',
		sessions: [managedSession({ attachedClients: '1' })]
	})), undefined);
	assert.equal(decodeWorkspaceServerMessage(JSON.stringify({
		type: 'sessions-snapshot',
		sessions: [managedSession({ isGitRepository: 'true' })]
	})), undefined);
	assert.equal(decodeWorkspaceServerMessage(JSON.stringify({
		type: 'sessions-snapshot',
		sessions: [managedSession({ favoriteCommands: ['pnpm dev', 42] })]
	})), undefined);
	assert.equal(decodeWorkspaceServerMessage(JSON.stringify({
		type: 'sessions-snapshot',
		sessions: [managedSession({ terminals: [{ id: '0', index: 0, name: 'shell', active: true, lastOutputAt: 3, foregroundProcess: null, command: null, startedAt: null, state: 'running', exitCode: null }] })]
	})), undefined);
	assert.equal(decodeWorkspaceServerMessage(JSON.stringify({
		type: 'session-updated',
		id: 'session-1',
		changes: { unknownField: true }
	})), undefined);
	assert.equal(decodeWorkspaceServerMessage(JSON.stringify({
		type: 'session-updated',
		id: 'session-1',
		changes: { agentState: 'done' }
	})), undefined);
});

test('keeps activity from legacy terminal updates without erasing richer terminal metadata', () => {
	assert.deepEqual(decodeWorkspaceServerMessage(JSON.stringify({
		type: 'session-updated',
		id: 'session-1',
		changes: {
			lastOutputAt: 4,
			terminals: [{
				id: '@0',
				index: 0,
				name: 'codex',
				active: true,
				lastOutputAt: 4,
				foregroundProcess: { kind: 'command', label: 'codex' }
			}]
		}
	})), {
		type: 'session-updated',
		id: 'session-1',
		changes: { lastOutputAt: 4 }
	});
});
