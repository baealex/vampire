import { isUnauthorized, requestJson } from '$lib/client/request';
import { maxTimestamp, sessionOutputBecameUnread, sortSessions } from './view';
import type { ManagedSession, SessionOrderMode } from './types';

type RefreshOptions = { quiet?: boolean };
type SessionChanges = Partial<Omit<ManagedSession, 'id'>>;

type SessionWorkspaceStateOptions = {
	navigate: (path: string) => void;
	onUnauthorized: () => void;
	isSessionObserved: (sessionId: string) => boolean;
};

const SESSION_ORDER_KEY = 'vampire:session-order';
const SESSION_ORDER_MODE_KEY = 'vampire:session-order-mode';
const OUTPUT_ACTIVITY_UPDATE_INTERVAL_MS = 500;

export class SessionWorkspaceState {
	sessions = $state<ManagedSession[]>([]);
	cwd = $state('');
	loading = $state(false);
	starting = $state(false);
	startError = $state('');
	newSessionOpen = $state(false);
	sessionsLoaded = $state(false);
	requestedSessionId = $state<string | undefined>(undefined);
	errorMessage = $state('');
	sessionAction = $state<'restart' | 'close' | 'remove' | undefined>(undefined);
	sessionActionError = $state('');
	sessionOrderMode = $state<SessionOrderMode>('recent');
	manualSessionOrder = $state<string[]>([]);
	activeOutputSessionId = $state<string | undefined>(undefined);
	unreadSessionIds = $state<Set<string>>(new Set());

	displayedSessions = $derived(sortSessions(this.sessions, this.sessionOrderMode, this.manualSessionOrder));
	activeSession = $derived(
		this.requestedSessionId
			? this.sessions.find((session) => session.id === this.requestedSessionId)
			: undefined
	);
	hasOpenSession = $derived(Boolean(this.activeSession || this.requestedSessionId));

	#activityRequestTimers = new Map<string, number>();
	#lastOutputActivityUpdate = new Map<string, number>();
	#observedOutputThrough = new Map<string, number>();
	#outputActivityTimers = new Map<string, number>();
	#pendingOutputActivity = new Map<string, number>();
	#refreshPromise: Promise<void> | undefined;
	#refreshQueued = false;
	#sessionsVersion = 0;

	constructor(private readonly options: SessionWorkspaceStateOptions) {}

	async refresh(options: RefreshOptions = {}) {
		if (!options.quiet) this.loading = true;
		if (this.#refreshPromise) {
			await this.#refreshPromise;
			if (!options.quiet) this.loading = false;
			return;
		}

		this.#refreshPromise = this.#runRefreshLoop();
		try {
			await this.#refreshPromise;
		} finally {
			this.#refreshPromise = undefined;
			if (!options.quiet) this.loading = false;
		}
	}

	applySessionSnapshot(sessions: ManagedSession[]) {
		this.applySessions(sessions);
	}

	applySessionAdded(session: ManagedSession) {
		if (this.sessions.some((item) => item.id === session.id)) {
			const { id, ...changes } = session;
			this.applySessionUpdated(id, changes);
			return;
		}
		this.applySessions([...this.sessions, session]);
	}

	applySessionUpdated(sessionId: string, changes: SessionChanges) {
		const previous = this.sessions.find((session) => session.id === sessionId);
		if (!previous) {
			void this.refresh({ quiet: true });
			return;
		}

		const previousOutputAt = previous.lastOutputAt;
		const next = {
			...previous,
			...changes,
			id: sessionId,
			lastActiveAt: Math.max(previous.lastActiveAt, changes.lastActiveAt ?? previous.lastActiveAt),
			lastOutputAt: maxTimestamp(changes.lastOutputAt ?? previous.lastOutputAt, previous.lastOutputAt)
		};
		if (this.sessionsLoaded && sessionOutputBecameUnread(
			previousOutputAt,
			next.lastOutputAt,
			this.#observedOutputThrough.get(sessionId) ?? 0,
			this.options.isSessionObserved(sessionId)
		)) {
			this.markSessionUnread(sessionId);
		}
		this.sessions = this.sessions.map((session) => session.id === sessionId ? next : session);
		this.syncManualSessionOrder();
	}

	applySessionRemoved(sessionId: string) {
		if (!this.sessions.some((session) => session.id === sessionId)) return;
		this.sessions = this.sessions.filter((session) => session.id !== sessionId);
		this.clearOutputActivity(sessionId);
		this.markSessionObserved(sessionId);
		this.#observedOutputThrough.delete(sessionId);
		if (this.activeOutputSessionId === sessionId) this.activeOutputSessionId = undefined;
		this.pruneUnreadSessions();
		this.syncManualSessionOrder();
	}

	async #runRefreshLoop() {
		do {
			this.#refreshQueued = false;
			const requestVersion = this.#sessionsVersion;
			this.errorMessage = '';
			try {
				const data = await requestJson<{ sessions: ManagedSession[] }>('/api/sessions');
				if (requestVersion !== this.#sessionsVersion) continue;
				this.applySessions(data.sessions);
			} catch (error) {
				if (requestVersion !== this.#sessionsVersion) continue;
				if (isUnauthorized(error)) this.options.onUnauthorized();
				else this.errorMessage = error instanceof Error ? error.message : 'Unable to load sessions';
			}
		} while (this.#refreshQueued);
	}

	private applySessions(incomingSessions: ManagedSession[]) {
		const previousSessions = new Map(this.sessions.map((session) => [session.id, session]));
		const nextSessions = incomingSessions.map((session) => {
			const previous = previousSessions.get(session.id);
			return {
				...session,
				lastActiveAt: Math.max(session.lastActiveAt, previous?.lastActiveAt ?? 0),
				lastOutputAt: maxTimestamp(session.lastOutputAt, previous?.lastOutputAt ?? null)
			};
		});

		if (this.sessionsLoaded) {
			for (const session of nextSessions) {
				const previousOutputAt = previousSessions.get(session.id)?.lastOutputAt ?? null;
				if (sessionOutputBecameUnread(
					previousOutputAt,
					session.lastOutputAt,
					this.#observedOutputThrough.get(session.id) ?? 0,
					this.options.isSessionObserved(session.id)
				)) {
					this.markSessionUnread(session.id);
				}
			}
		}

		this.sessions = nextSessions;
		this.pruneUnreadSessions();
		this.syncManualSessionOrder();
		if (!this.sessionsLoaded) {
			this.newSessionOpen = this.sessions.length === 0;
			this.sessionsLoaded = true;
		}
	}

	async createSession(tmuxAvailable?: boolean): Promise<boolean> {
		if (tmuxAvailable === false) {
			this.startError = 'Install tmux on the server computer before starting a session.';
			return false;
		}
		this.starting = true;
		this.startError = '';
		try {
			const data = await requestJson<{ session: ManagedSession }>('/api/sessions', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ cwd: this.cwd })
			});
			this.invalidateSessions();
			this.cwd = '';
			this.newSessionOpen = false;
			this.sessions = [data.session, ...this.sessions.filter((session) => session.id !== data.session.id)];
			this.manualSessionOrder = [data.session.id, ...this.manualSessionOrder.filter((id) => id !== data.session.id)];
			this.persistManualSessionOrder();
			this.openSession(data.session);
			void this.refresh({ quiet: true });
			return true;
		} catch (error) {
			this.startError = error instanceof Error ? error.message : 'Unable to start the shell';
			return false;
		} finally {
			this.starting = false;
		}
	}

	async updateSessionNote(sessionId: string, note: string) {
		const data = await requestJson<{ note: string }>(`/api/sessions/${encodeURIComponent(sessionId)}/note`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ note })
		});
		this.sessions = this.sessions.map((session) => session.id === sessionId ? { ...session, note: data.note } : session);
	}

	restoreBrowserPreferences(storage: Storage) {
		const savedOrderMode = storage.getItem(SESSION_ORDER_MODE_KEY);
		if (savedOrderMode === 'recent' || savedOrderMode === 'manual') this.sessionOrderMode = savedOrderMode;
		try {
			const savedOrder: unknown = JSON.parse(storage.getItem(SESSION_ORDER_KEY) ?? '[]');
			if (Array.isArray(savedOrder) && savedOrder.every((id) => typeof id === 'string')) {
				this.manualSessionOrder = savedOrder;
			}
		} catch {
			this.manualSessionOrder = [];
		}
	}

	setSessionOrderMode(mode: SessionOrderMode) {
		this.sessionOrderMode = mode;
		window.localStorage.setItem(SESSION_ORDER_MODE_KEY, mode);
		if (mode === 'manual') this.syncManualSessionOrder();
	}

	reorderSession(draggedId: string, targetId: string, position: 'before' | 'after') {
		if (draggedId === targetId) return;
		const order = this.displayedSessions.map((session) => session.id).filter((id) => id !== draggedId);
		const targetIndex = order.indexOf(targetId);
		if (targetIndex < 0) return;
		order.splice(targetIndex + (position === 'after' ? 1 : 0), 0, draggedId);
		this.manualSessionOrder = order;
		this.persistManualSessionOrder();
	}

	recordSessionInput(sessionId: string, timestamp: number) {
		this.sessions = this.sessions.map((session) => session.id === sessionId ? { ...session, lastActiveAt: timestamp } : session);
		const existingTimer = this.#activityRequestTimers.get(sessionId);
		if (existingTimer !== undefined) window.clearTimeout(existingTimer);
		this.#activityRequestTimers.set(sessionId, window.setTimeout(() => {
			this.#activityRequestTimers.delete(sessionId);
			void requestJson<{ lastActiveAt: number }>(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'PATCH' })
				.then(({ lastActiveAt }) => {
					this.sessions = this.sessions.map((session) => session.id === sessionId
						? { ...session, lastActiveAt: Math.max(session.lastActiveAt, lastActiveAt) }
						: session);
				})
				.catch(() => undefined);
		}, 600));
	}

	recordSessionOutput(sessionId: string, active: boolean, timestamp?: number, observed = false) {
		if (active) {
			this.activeOutputSessionId = sessionId;
			if (observed) this.markSessionObserved(sessionId, timestamp);
			else this.markSessionUnread(sessionId);
			this.recordOutputActivity(sessionId, timestamp ?? Date.now());
		} else if (this.activeOutputSessionId === sessionId) {
			this.flushOutputActivity(sessionId);
			this.activeOutputSessionId = undefined;
		}
	}

	markSessionObserved(sessionId: string, timestamp = Date.now()) {
		this.#observedOutputThrough.set(
			sessionId,
			Math.max(timestamp, this.#observedOutputThrough.get(sessionId) ?? 0)
		);
		if (!this.unreadSessionIds.has(sessionId)) return;
		const nextUnreadSessionIds = new Set(this.unreadSessionIds);
		nextUnreadSessionIds.delete(sessionId);
		this.unreadSessionIds = nextUnreadSessionIds;
	}

	openSession(session: ManagedSession) {
		const previousSessionId = this.requestedSessionId;
		if (
			previousSessionId
			&& previousSessionId !== session.id
			&& this.options.isSessionObserved(previousSessionId)
		) {
			this.markSessionObserved(previousSessionId);
		}
		this.markSessionObserved(session.id);
		if (this.activeSession?.id === session.id && this.requestedSessionId === session.id) return;
		this.requestedSessionId = session.id;
		this.sessionActionError = '';
		this.options.navigate(`/sessions/${encodeURIComponent(session.id)}`);
	}

	clearActiveSession() {
		if (this.requestedSessionId && this.options.isSessionObserved(this.requestedSessionId)) {
			this.markSessionObserved(this.requestedSessionId);
		}
		this.requestedSessionId = undefined;
		this.sessionActionError = '';
		this.options.navigate('/');
	}

	syncLocation(pathname: string) {
		const match = /^\/sessions\/([^/]+)\/?$/.exec(pathname);
		const nextSessionId = match ? decodeURIComponent(match[1]) : undefined;
		if (
			this.requestedSessionId
			&& this.requestedSessionId !== nextSessionId
			&& this.options.isSessionObserved(this.requestedSessionId)
		) {
			this.markSessionObserved(this.requestedSessionId);
		}
		this.requestedSessionId = nextSessionId;
		if (this.requestedSessionId && this.options.isSessionObserved(this.requestedSessionId)) {
			this.markSessionObserved(this.requestedSessionId);
		}
		this.sessionActionError = '';
	}

	async restartSession(session: ManagedSession): Promise<boolean> {
		this.sessionAction = 'restart';
		this.sessionActionError = '';
		try {
			const data = await requestJson<{ session: ManagedSession }>(`/api/sessions/${encodeURIComponent(session.id)}`, {
				method: 'POST'
			});
			this.invalidateSessions();
			this.sessions = this.sessions.map((item) => item.id === data.session.id ? data.session : item);
			void this.refresh({ quiet: true });
			return true;
		} catch (error) {
			this.sessionActionError = error instanceof Error ? error.message : 'Unable to restart the session';
			return false;
		} finally {
			this.sessionAction = undefined;
		}
	}

	async closeSession(session: ManagedSession): Promise<boolean> {
		this.sessionAction = 'close';
		this.sessionActionError = '';
		try {
			await requestJson<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(session.id)}/close`, { method: 'POST' });
			this.invalidateSessions();
			this.sessions = this.sessions.map((item) => item.id === session.id
				? { ...item, state: 'missing', lastOutputAt: null, attachedClients: 0, foregroundProcess: null }
				: item);
			this.clearOutputActivity(session.id);
			this.markSessionObserved(session.id);
			if (this.activeOutputSessionId === session.id) this.activeOutputSessionId = undefined;
			if (this.requestedSessionId === session.id) this.clearActiveSession();
			void this.refresh({ quiet: true });
			return true;
		} catch (error) {
			this.sessionActionError = error instanceof Error ? error.message : 'Unable to close the session';
			return false;
		} finally {
			this.sessionAction = undefined;
		}
	}

	async removeSession(session: ManagedSession): Promise<boolean> {
		this.sessionAction = 'remove';
		this.sessionActionError = '';
		try {
			await requestJson<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(session.id)}`, { method: 'DELETE' });
			this.invalidateSessions();
			this.sessions = this.sessions.filter((item) => item.id !== session.id);
			this.manualSessionOrder = this.manualSessionOrder.filter((id) => id !== session.id);
			this.clearOutputActivity(session.id);
			this.markSessionObserved(session.id);
			this.#observedOutputThrough.delete(session.id);
			this.persistManualSessionOrder();
			if (this.requestedSessionId === session.id) this.clearActiveSession();
			return true;
		} catch (error) {
			this.sessionActionError = error instanceof Error ? error.message : 'Unable to remove the workspace';
			return false;
		} finally {
			this.sessionAction = undefined;
		}
	}

	reset() {
		this.invalidateSessions();
		this.clearAllInputActivity();
		this.clearAllOutputActivity();
		this.sessions = [];
		this.requestedSessionId = undefined;
		this.activeOutputSessionId = undefined;
		this.unreadSessionIds = new Set();
		this.#observedOutputThrough.clear();
		this.sessionsLoaded = false;
		this.newSessionOpen = false;
		this.errorMessage = '';
		this.sessionActionError = '';
	}

	dispose() {
		this.clearAllInputActivity();
		this.clearAllOutputActivity();
	}

	private invalidateSessions() {
		this.#sessionsVersion += 1;
		this.#refreshQueued = true;
	}

	private recordOutputActivity(sessionId: string, timestamp: number) {
		const now = Date.now();
		const elapsed = now - (this.#lastOutputActivityUpdate.get(sessionId) ?? -Infinity);
		if (elapsed >= OUTPUT_ACTIVITY_UPDATE_INTERVAL_MS) {
			const scheduledTimer = this.#outputActivityTimers.get(sessionId);
			if (scheduledTimer !== undefined) window.clearTimeout(scheduledTimer);
			this.#outputActivityTimers.delete(sessionId);
			this.commitOutputActivity(sessionId, timestamp, now);
			return;
		}

		this.#pendingOutputActivity.set(sessionId, timestamp);
		if (this.#outputActivityTimers.has(sessionId)) return;
		this.#outputActivityTimers.set(sessionId, window.setTimeout(() => {
			this.#outputActivityTimers.delete(sessionId);
			const pendingTimestamp = this.#pendingOutputActivity.get(sessionId);
			if (pendingTimestamp !== undefined) this.commitOutputActivity(sessionId, pendingTimestamp, Date.now());
		}, OUTPUT_ACTIVITY_UPDATE_INTERVAL_MS - elapsed));
	}

	private flushOutputActivity(sessionId: string) {
		const timer = this.#outputActivityTimers.get(sessionId);
		if (timer !== undefined) window.clearTimeout(timer);
		this.#outputActivityTimers.delete(sessionId);
		const pendingTimestamp = this.#pendingOutputActivity.get(sessionId);
		if (pendingTimestamp !== undefined) this.commitOutputActivity(sessionId, pendingTimestamp, Date.now());
	}

	private commitOutputActivity(sessionId: string, timestamp: number, recordedAt: number) {
		this.#pendingOutputActivity.delete(sessionId);
		this.#lastOutputActivityUpdate.set(sessionId, recordedAt);
		const session = this.sessions.find((item) => item.id === sessionId);
		if (!session) return;
		const lastOutputAt = maxTimestamp(session.lastOutputAt, timestamp);
		if (lastOutputAt === session.lastOutputAt) return;
		this.sessions = this.sessions.map((item) => sessionId === item.id ? { ...item, lastOutputAt } : item);
	}

	private markSessionUnread(sessionId: string) {
		if (this.unreadSessionIds.has(sessionId)) return;
		this.unreadSessionIds = new Set(this.unreadSessionIds).add(sessionId);
	}

	private pruneUnreadSessions() {
		const sessionIds = new Set(this.sessions.map((session) => session.id));
		const nextUnreadSessionIds = new Set([...this.unreadSessionIds].filter((id) => sessionIds.has(id)));
		if (nextUnreadSessionIds.size !== this.unreadSessionIds.size) this.unreadSessionIds = nextUnreadSessionIds;
		for (const sessionId of this.#observedOutputThrough.keys()) {
			if (!sessionIds.has(sessionId)) this.#observedOutputThrough.delete(sessionId);
		}
	}

	private clearOutputActivity(sessionId: string) {
		const timer = this.#outputActivityTimers.get(sessionId);
		if (timer !== undefined) window.clearTimeout(timer);
		this.#outputActivityTimers.delete(sessionId);
		this.#pendingOutputActivity.delete(sessionId);
		this.#lastOutputActivityUpdate.delete(sessionId);
	}

	private clearAllOutputActivity() {
		for (const timer of this.#outputActivityTimers.values()) window.clearTimeout(timer);
		this.#outputActivityTimers.clear();
		this.#pendingOutputActivity.clear();
		this.#lastOutputActivityUpdate.clear();
	}

	private clearAllInputActivity() {
		for (const timer of this.#activityRequestTimers.values()) window.clearTimeout(timer);
		this.#activityRequestTimers.clear();
	}

	private persistManualSessionOrder() {
		window.localStorage.setItem(SESSION_ORDER_KEY, JSON.stringify(this.manualSessionOrder));
	}

	private syncManualSessionOrder() {
		const sessionIds = new Set(this.sessions.map((session) => session.id));
		const nextOrder = [
			...this.manualSessionOrder.filter((id) => sessionIds.has(id)),
			...this.sessions.map((session) => session.id).filter((id) => !this.manualSessionOrder.includes(id))
		];
		if (nextOrder.join('\0') === this.manualSessionOrder.join('\0')) return;
		this.manualSessionOrder = nextOrder;
		this.persistManualSessionOrder();
	}
}
