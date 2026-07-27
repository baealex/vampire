import type { ManagedSession, SessionOrderMode, SessionProcess } from './types';

const SESSION_PROCESS_COLORS = [
	'var(--color-agent)',
	'var(--color-command)',
	'var(--color-success)',
	'var(--color-info)',
	'var(--color-note)',
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
	activeOutputSessionId?: string,
	hasUnreadOutput = false
): boolean {
	return session.state === 'running' && (
		activeOutputSessionId === session.id
		|| (hasUnreadOutput && session.lastOutputAt !== null && Date.now() - session.lastOutputAt < 4_000)
	);
}

export function sessionOutputBecameUnread(
	previousOutputAt: number | null,
	nextOutputAt: number | null,
	observedThrough: number,
	isObserved: boolean
): boolean {
	const previous = previousOutputAt ?? 0;
	const next = nextOutputAt ?? 0;
	return !isObserved && next > previous && next > observedThrough;
}

export type SessionActivityState = 'live' | 'review' | 'idle' | 'missing';

const SESSION_ACTIVITY_PRIORITY: Record<SessionActivityState, number> = {
	review: 0,
	live: 1,
	idle: 2,
	missing: 3
};

export function sessionActivityPriority(state: SessionActivityState): number {
	return SESSION_ACTIVITY_PRIORITY[state];
}

export function sessionActivityState(
	session: ManagedSession,
	activeOutputSessionId?: string,
	hasUnreadOutput = false
): SessionActivityState {
	if (session.state === 'missing') return 'missing';
	if (sessionIsActive(session, activeOutputSessionId, hasUnreadOutput)) return 'live';
	if (hasUnreadOutput) return 'review';
	return 'idle';
}

export function sessionActivityHint(
	session: ManagedSession,
	activeOutputSessionId?: string,
	hasUnreadOutput = false
): string {
	if (session.state === 'missing') return 'tmux session unavailable';
	const state = sessionActivityState(session, activeOutputSessionId, hasUnreadOutput);
	if (state === 'live') return 'Recent terminal output';
	if (state === 'review') return 'Terminal output has not been viewed yet';
	return 'No unreviewed terminal output';
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
