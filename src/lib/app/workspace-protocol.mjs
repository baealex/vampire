/**
 * @typedef {{ kind: 'shell' | 'command'; label: string }} ForegroundProcessMessage
 * @typedef {{ id: string; tmuxSession: string; cwd: string; createdAt: number; lastActiveAt: number; notePreview: string; state: 'running' | 'missing'; lastOutputAt: number | null; attachedClients: number; foregroundProcess: ForegroundProcessMessage | null; isGitRepository: boolean }} ManagedSessionMessage
 * @typedef {{ cpuUsage: number; memoryUsage: number; memoryUsedBytes: number; memoryTotalBytes: number }} SystemMetricsMessage
 * @typedef {Partial<Omit<ManagedSessionMessage, 'id'>>} SessionChangesMessage
 * @typedef {{ type: 'sessions-snapshot'; sessions: ManagedSessionMessage[] } | { type: 'session-added'; session: ManagedSessionMessage } | { type: 'session-updated'; id: string; changes: SessionChangesMessage } | { type: 'session-removed'; id: string } | { type: 'system-metrics'; metrics: SystemMetricsMessage } | { type: 'error'; message: string }} WorkspaceServerMessage
 */

const SESSION_CHANGE_FIELDS = new Set([
	'tmuxSession',
	'cwd',
	'createdAt',
	'lastActiveAt',
	'notePreview',
	'state',
	'lastOutputAt',
	'attachedClients',
	'foregroundProcess',
	'isGitRepository'
]);

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** @param {unknown} value */
function isFiniteNumber(value) {
	return typeof value === 'number' && Number.isFinite(value);
}

/** @param {unknown} value @returns {value is ForegroundProcessMessage | null} */
function isForegroundProcess(value) {
	return value === null || (
		isRecord(value)
		&& (value.kind === 'shell' || value.kind === 'command')
		&& typeof value.label === 'string'
	);
}

/** @param {unknown} value @returns {value is ManagedSessionMessage} */
export function isManagedSessionMessage(value) {
	return isRecord(value)
		&& typeof value.id === 'string'
		&& typeof value.tmuxSession === 'string'
		&& typeof value.cwd === 'string'
		&& isFiniteNumber(value.createdAt)
		&& isFiniteNumber(value.lastActiveAt)
		&& typeof value.notePreview === 'string'
		&& (value.state === 'running' || value.state === 'missing')
		&& (value.lastOutputAt === null || isFiniteNumber(value.lastOutputAt))
		&& Number.isInteger(value.attachedClients)
		&& Number(value.attachedClients) >= 0
		&& isForegroundProcess(value.foregroundProcess)
		&& typeof value.isGitRepository === 'boolean';
}

/** @param {unknown} value @returns {value is SystemMetricsMessage} */
export function isSystemMetricsMessage(value) {
	return isRecord(value)
		&& isFiniteNumber(value.cpuUsage)
		&& isFiniteNumber(value.memoryUsage)
		&& isFiniteNumber(value.memoryUsedBytes)
		&& isFiniteNumber(value.memoryTotalBytes);
}

/** @param {unknown} value @returns {value is SessionChangesMessage} */
export function isSessionChangesMessage(value) {
	if (!isRecord(value) || Object.keys(value).some((key) => !SESSION_CHANGE_FIELDS.has(key))) return false;
	return (value.tmuxSession === undefined || typeof value.tmuxSession === 'string')
		&& (value.cwd === undefined || typeof value.cwd === 'string')
		&& (value.createdAt === undefined || isFiniteNumber(value.createdAt))
		&& (value.lastActiveAt === undefined || isFiniteNumber(value.lastActiveAt))
		&& (value.notePreview === undefined || typeof value.notePreview === 'string')
		&& (value.state === undefined || value.state === 'running' || value.state === 'missing')
		&& (value.lastOutputAt === undefined || value.lastOutputAt === null || isFiniteNumber(value.lastOutputAt))
		&& (value.attachedClients === undefined || (Number.isInteger(value.attachedClients) && Number(value.attachedClients) >= 0))
		&& (value.foregroundProcess === undefined || isForegroundProcess(value.foregroundProcess))
		&& (value.isGitRepository === undefined || typeof value.isGitRepository === 'boolean');
}

/** @param {unknown} value @returns {WorkspaceServerMessage | undefined} */
export function parseWorkspaceServerMessage(value) {
	if (!isRecord(value)) return undefined;
	if (value.type === 'sessions-snapshot' && Array.isArray(value.sessions) && value.sessions.every(isManagedSessionMessage)) {
		return { type: 'sessions-snapshot', sessions: value.sessions };
	}
	if (value.type === 'session-added' && isManagedSessionMessage(value.session)) {
		return { type: 'session-added', session: value.session };
	}
	if (value.type === 'session-updated' && typeof value.id === 'string' && isSessionChangesMessage(value.changes)) {
		return { type: 'session-updated', id: value.id, changes: value.changes };
	}
	if (value.type === 'session-removed' && typeof value.id === 'string') {
		return { type: 'session-removed', id: value.id };
	}
	if (value.type === 'system-metrics' && isSystemMetricsMessage(value.metrics)) {
		return { type: 'system-metrics', metrics: value.metrics };
	}
	if (value.type === 'error' && typeof value.message === 'string') {
		return { type: 'error', message: value.message };
	}
	return undefined;
}

/** @param {unknown} raw @returns {WorkspaceServerMessage | undefined} */
export function decodeWorkspaceServerMessage(raw) {
	try {
		return parseWorkspaceServerMessage(JSON.parse(typeof raw === 'string' ? raw : String(raw)));
	} catch {
		return undefined;
	}
}

/** @param {WorkspaceServerMessage} message */
export function encodeWorkspaceServerMessage(message) {
	const parsed = parseWorkspaceServerMessage(message);
	if (!parsed) throw new TypeError('Invalid workspace server message.');
	return JSON.stringify(parsed);
}
