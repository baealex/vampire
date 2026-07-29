import type { ManagedSession, SessionOrderMode, SessionProcess } from './types';

export const SESSION_OUTPUT_SETTLE_MS = 8_000;

export type SessionActivityState = 'active' | 'review' | 'idle' | 'ended';
export type SessionActivityRecord = {
	activeUntil: number;
	seenThroughAt: number;
};
export type SessionActivityRecords = ReadonlyMap<string, SessionActivityRecord>;

const SESSION_PROCESS_COLORS = [
	'var(--color-agent)',
	'var(--color-command)',
	'var(--color-success)',
	'var(--color-info)',
	'var(--terminal-blue)',
	'var(--color-folder)',
	'var(--color-image)',
	'var(--color-renamed)',
	'var(--terminal-cyan)',
	'var(--terminal-magenta)',
	'var(--terminal-bright-red)',
	'var(--terminal-bright-yellow)'
] as const;

export function projectName(path: string): string {
	return path.replace(/\/+$/, '').split('/').pop() || path;
}

export function sessionProcess(session: ManagedSession): SessionProcess | null {
	if (session.state === 'missing') return null;
	const process = session.foregroundProcess ?? { kind: 'shell', label: 'shell' };
	return { ...process, label: process.label.toLowerCase() };
}

export function sessionProcessColor(process: SessionProcess): string {
	if (process.kind === 'shell') return 'var(--color-text-secondary)';

	const { label } = process;
	let hash = 0;
	for (const character of label.toLowerCase()) {
		hash = (hash * 31 + (character.codePointAt(0) ?? 0)) >>> 0;
	}
	return SESSION_PROCESS_COLORS[hash % SESSION_PROCESS_COLORS.length];
}

export function sessionProcessHint(session: ManagedSession): string {
	if (session.state === 'missing') return 'tmux session unavailable';
	const process = sessionProcess(session);
	if (!process) return 'Shell is waiting for input';
	if (process.kind === 'command') return `Foreground command: ${process.label}`;
	return 'Shell is waiting for input';
}

export function sessionIsActive(
	session: ManagedSession,
	activityRecords: SessionActivityRecords = new Map(),
	now = Date.now()
): boolean {
	return session.state === 'running' && (activityRecords.get(session.id)?.activeUntil ?? 0) > now;
}

const SESSION_ACTIVITY_PRIORITY: Record<SessionActivityState, number> = {
	active: 0,
	review: 1,
	idle: 2,
	ended: 3
};

export function sessionActivityPriority(state: SessionActivityState): number {
	return SESSION_ACTIVITY_PRIORITY[state];
}

export function buildActivityOrder(
	sessions: ManagedSession[],
	previousOrder: string[],
	activityRecords: SessionActivityRecords = new Map()
): string[] {
	const currentIds = new Set(sessions.map((session) => session.id));
	const existingOrder = previousOrder.filter((sessionId) => currentIds.has(sessionId));
	const knownIds = new Set(existingOrder);
	const baseOrder = [
		...existingOrder,
		...sessions.filter((session) => !knownIds.has(session.id)).map((session) => session.id)
	];
	const states = new Map(sessions.map((session) => [
		session.id,
		sessionActivityState(session, activityRecords)
	]));
	const basePosition = new Map(baseOrder.map((sessionId, index) => [sessionId, index]));
	return [...baseOrder].sort((left, right) =>
		sessionActivityPriority(states.get(left) ?? 'idle')
		- sessionActivityPriority(states.get(right) ?? 'idle')
		|| (basePosition.get(left) ?? Number.MAX_SAFE_INTEGER) - (basePosition.get(right) ?? Number.MAX_SAFE_INTEGER)
	);
}

export function reconcileSessionOrder(sessions: ManagedSession[], manualOrder: string[]): string[] {
	const sessionIds = new Set(sessions.map((session) => session.id));
	return [
		...manualOrder.filter((id) => sessionIds.has(id)),
		...sessions.map((session) => session.id).filter((id) => !manualOrder.includes(id))
	];
}

export function sessionActivityState(
	session: ManagedSession,
	activityRecords: SessionActivityRecords = new Map(),
	now = Date.now()
): SessionActivityState {
	if (session.state === 'missing') return 'ended';
	const activity = activityRecords.get(session.id);
	if (sessionIsActive(session, activityRecords, now)) return 'active';
	if ((session.lastOutputAt ?? 0) > (activity?.seenThroughAt ?? 0)) return 'review';
	return 'idle';
}

export function sessionActivityHint(
	session: ManagedSession,
	activityRecords: SessionActivityRecords = new Map()
): string {
	if (session.state === 'missing') return 'Shell is offline';
	const state = sessionActivityState(session, activityRecords);
	if (state === 'active') return 'Terminal is working; check back later';
	if (state === 'review') return 'Terminal output is ready and needs review';
	return 'Shell is online and up to date';
}

export function maxTimestamp(left: number | null, right: number | null): number | null {
	if (left === null) return right;
	if (right === null) return left;
	return Math.max(left, right);
}

export function latestSessionOutputAt(session: ManagedSession): number {
	return session.lastOutputAt ?? session.lastActiveAt;
}

export function sortSessions(
	sessions: ManagedSession[],
	mode: SessionOrderMode,
	manualOrder: string[],
	activityOrder: string[] = []
): ManagedSession[] {
	if (mode === 'activity') {
		const position = new Map(activityOrder.map((id, index) => [id, index]));
		return [...sessions].sort((left, right) =>
			(position.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (position.get(right.id) ?? Number.MAX_SAFE_INTEGER)
			|| left.createdAt - right.createdAt
			|| left.id.localeCompare(right.id)
		);
	}

	const position = new Map(manualOrder.map((id, index) => [id, index]));
	return [...sessions].sort((left, right) =>
		(position.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (position.get(right.id) ?? Number.MAX_SAFE_INTEGER)
		|| left.createdAt - right.createdAt
	);
}

export function formatSessionTimestamp(value: number): string {
	const elapsed = Math.max(0, Date.now() - value);
	const minutes = Math.floor(elapsed / 60_000);
	if (minutes < 1) return 'now';
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d ago`;
	const months = Math.floor(days / 30);
	if (months < 12) return `${months}mo ago`;
	return `${Math.floor(months / 12)}y ago`;
}
