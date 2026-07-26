import type { ManagedSession, SessionOrderMode, SessionProcess } from './types';

export function projectName(path: string): string {
	return path.replace(/\/+$/, '').split('/').pop() || path;
}

export function sessionProcess(session: ManagedSession): SessionProcess {
	return session.foregroundProcess ?? { kind: 'shell', label: 'Shell' };
}

export function sessionProcessHint(session: ManagedSession): string {
	if (session.state === 'missing') return 'tmux session unavailable';
	const process = sessionProcess(session);
	if (process.kind === 'agent') return `${process.label} process detected in the foreground pane`;
	if (process.kind === 'command') return `Foreground command: ${process.label}`;
	return 'Shell is waiting for input';
}

export function sessionIsActive(session: ManagedSession, activeOutputSessionId?: string): boolean {
	return session.state === 'running' && (
		activeOutputSessionId === session.id
		|| (session.lastOutputAt !== null && Date.now() - session.lastOutputAt < 4_000)
	);
}

export type SessionActivityState = 'live' | 'review' | 'idle' | 'missing';

export function sessionActivityState(
	session: ManagedSession,
	activeOutputSessionId?: string,
	hasUnreadOutput = false
): SessionActivityState {
	if (session.state === 'missing') return 'missing';
	if (sessionIsActive(session, activeOutputSessionId)) return 'live';
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
	manualOrder: string[]
): ManagedSession[] {
	if (mode === 'recent') {
		return [...sessions].sort((left, right) =>
			latestSessionOutputAt(right) - latestSessionOutputAt(left) || right.createdAt - left.createdAt
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
