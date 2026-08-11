import type { ManagedSession, SessionProcess, SessionTerminal } from '../session/types.ts';

export type SessionChanges = Partial<Omit<ManagedSession, 'id'>>;

export type WorkspaceServerMessage =
	| { type: 'sessions-snapshot'; sessions: ManagedSession[] }
	| { type: 'session-added'; session: ManagedSession }
	| { type: 'session-updated'; id: string; changes: SessionChanges }
	| { type: 'session-removed'; id: string }
	| { type: 'error'; message: string };

const SESSION_CHANGE_FIELDS = new Set([
	'tmuxSession',
	'cwd',
	'createdAt',
	'lastActiveAt',
	'notePreview',
	'favoriteCommands',
	'state',
	'lastOutputAt',
	'attachedClients',
	'foregroundProcess',
	'terminals',
	'agentState',
	'isGitRepository'
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function isForegroundProcess(value: unknown): value is SessionProcess | null {
	return value === null || (
		isRecord(value)
		&& (value.kind === 'shell' || value.kind === 'command')
		&& typeof value.label === 'string'
	);
}

function isSessionTerminal(value: unknown): value is SessionTerminal {
	return isRecord(value)
		&& typeof value.id === 'string'
		&& /^@\d+$/.test(value.id)
		&& Number.isInteger(value.index)
		&& Number(value.index) >= 0
		&& typeof value.name === 'string'
		&& typeof value.active === 'boolean'
		&& (value.lastOutputAt === null || isFiniteNumber(value.lastOutputAt))
		&& isForegroundProcess(value.foregroundProcess)
		&& (value.command === null || typeof value.command === 'string')
		&& (value.startedAt === null || isFiniteNumber(value.startedAt))
		&& (value.state === 'running' || value.state === 'exited')
		&& (value.exitCode === null || Number.isInteger(value.exitCode));
}

/**
 * Older development servers sent only the terminal fields that existed before
 * background commands were introduced. Accept that shape for incremental
 * updates so a hot-reloaded client does not discard otherwise valid activity.
 *
 */
function isSessionTerminalUpdate(value: unknown): value is Partial<SessionTerminal> & Pick<SessionTerminal, 'id' | 'index' | 'name' | 'active' | 'lastOutputAt' | 'foregroundProcess'> {
	return isRecord(value)
		&& typeof value.id === 'string'
		&& /^@\d+$/.test(value.id)
		&& Number.isInteger(value.index)
		&& Number(value.index) >= 0
		&& typeof value.name === 'string'
		&& typeof value.active === 'boolean'
		&& (value.lastOutputAt === null || isFiniteNumber(value.lastOutputAt))
		&& isForegroundProcess(value.foregroundProcess)
		&& (value.command === undefined || value.command === null || typeof value.command === 'string')
		&& (value.startedAt === undefined || value.startedAt === null || isFiniteNumber(value.startedAt))
		&& (value.state === undefined || value.state === 'running' || value.state === 'exited')
		&& (value.exitCode === undefined || value.exitCode === null || Number.isInteger(value.exitCode));
}

function normalizeSessionChanges(value: SessionChanges): SessionChanges {
	if (!Array.isArray(value.terminals)) return value;
	const terminalUpdates = value.terminals as Array<Record<string, unknown>>;
	if (terminalUpdates.every(isSessionTerminal)) return value;

	// A legacy terminal array cannot safely replace the richer client-side
	// records because doing so would erase background command metadata. The
	// session timestamp represents the main terminal in that protocol, so keep
	// it and let the session store advance the main terminal from that value.
	const { terminals: _terminals, ...changes } = value;
	const mainOutputAt = terminalUpdates[0]?.lastOutputAt;
	if (changes.lastOutputAt === undefined && typeof mainOutputAt === 'number') {
		changes.lastOutputAt = mainOutputAt;
	}
	return changes;
}

export function isManagedSessionMessage(value: unknown): value is ManagedSession {
	return isRecord(value)
		&& typeof value.id === 'string'
		&& typeof value.tmuxSession === 'string'
		&& typeof value.cwd === 'string'
		&& isFiniteNumber(value.createdAt)
		&& isFiniteNumber(value.lastActiveAt)
		&& typeof value.notePreview === 'string'
		&& Array.isArray(value.favoriteCommands)
		&& value.favoriteCommands.every((command) => typeof command === 'string')
		&& (value.state === 'running' || value.state === 'missing')
		&& (value.lastOutputAt === null || isFiniteNumber(value.lastOutputAt))
		&& Number.isInteger(value.attachedClients)
		&& Number(value.attachedClients) >= 0
		&& isForegroundProcess(value.foregroundProcess)
		&& Array.isArray(value.terminals)
		&& value.terminals.every(isSessionTerminal)
		&& (value.agentState === undefined || value.agentState === null || value.agentState === 'working' || value.agentState === 'waiting')
		&& typeof value.isGitRepository === 'boolean';
}

export function isSessionChangesMessage(value: unknown): value is SessionChanges {
	if (!isRecord(value) || Object.keys(value).some((key) => !SESSION_CHANGE_FIELDS.has(key))) return false;
	return (value.tmuxSession === undefined || typeof value.tmuxSession === 'string')
		&& (value.cwd === undefined || typeof value.cwd === 'string')
		&& (value.createdAt === undefined || isFiniteNumber(value.createdAt))
		&& (value.lastActiveAt === undefined || isFiniteNumber(value.lastActiveAt))
		&& (value.notePreview === undefined || typeof value.notePreview === 'string')
		&& (value.favoriteCommands === undefined || (
			Array.isArray(value.favoriteCommands)
			&& value.favoriteCommands.every((command) => typeof command === 'string')
		))
		&& (value.state === undefined || value.state === 'running' || value.state === 'missing')
		&& (value.lastOutputAt === undefined || value.lastOutputAt === null || isFiniteNumber(value.lastOutputAt))
		&& (value.attachedClients === undefined || (Number.isInteger(value.attachedClients) && Number(value.attachedClients) >= 0))
		&& (value.foregroundProcess === undefined || isForegroundProcess(value.foregroundProcess))
		&& (value.terminals === undefined || (Array.isArray(value.terminals) && value.terminals.every(isSessionTerminalUpdate)))
		&& (value.agentState === undefined || value.agentState === null || value.agentState === 'working' || value.agentState === 'waiting')
		&& (value.isGitRepository === undefined || typeof value.isGitRepository === 'boolean');
}

export function parseWorkspaceServerMessage(value: unknown): WorkspaceServerMessage | undefined {
	if (!isRecord(value)) return undefined;
	if (value.type === 'sessions-snapshot' && Array.isArray(value.sessions) && value.sessions.every(isManagedSessionMessage)) {
		return { type: 'sessions-snapshot', sessions: value.sessions };
	}
	if (value.type === 'session-added' && isManagedSessionMessage(value.session)) {
		return { type: 'session-added', session: value.session };
	}
	if (value.type === 'session-updated' && typeof value.id === 'string' && isSessionChangesMessage(value.changes)) {
		return { type: 'session-updated', id: value.id, changes: normalizeSessionChanges(value.changes) };
	}
	if (value.type === 'session-removed' && typeof value.id === 'string') {
		return { type: 'session-removed', id: value.id };
	}
	if (value.type === 'error' && typeof value.message === 'string') {
		return { type: 'error', message: value.message };
	}
	return undefined;
}

export function decodeWorkspaceServerMessage(raw: unknown): WorkspaceServerMessage | undefined {
	try {
		return parseWorkspaceServerMessage(JSON.parse(typeof raw === 'string' ? raw : String(raw)));
	} catch {
		return undefined;
	}
}

export function encodeWorkspaceServerMessage(message: WorkspaceServerMessage): string {
	const parsed = parseWorkspaceServerMessage(message);
	if (!parsed) throw new TypeError('Invalid workspace server message.');
	return JSON.stringify(parsed);
}
