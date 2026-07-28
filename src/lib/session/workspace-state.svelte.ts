import { isUnauthorized, requestJson } from '$lib/client/request';
import {
	maxTimestamp,
	reconcileSessionOrder,
	sortSessions
} from './view';
import { SessionActivityController } from './activity-controller';
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
	sessionOrderMode = $state<SessionOrderMode>('activity');
	manualSessionOrder = $state<string[]>([]);
	activityOrder = $state<string[]>([]);
	activeOutputSessionId = $state<string | undefined>(undefined);
	unreadSessionIds = $state<Set<string>>(new Set());

	displayedSessions = $derived(sortSessions(
		this.sessions,
		this.sessionOrderMode,
		this.manualSessionOrder,
		this.activityOrder
	));
	activeSession = $derived(
		this.requestedSessionId
			? this.sessions.find((session) => session.id === this.requestedSessionId)
			: undefined
	);
	hasOpenSession = $derived(Boolean(this.activeSession || this.requestedSessionId));

	#activityRequestTimers = new Map<string, number>();
	#activity: SessionActivityController;
	#sessionNotes = new Map<string, string>();
	#sessionNoteRequests = new Map<string, Promise<string>>();
	#refreshPromise: Promise<void> | undefined;
	#refreshQueued = false;
	#sessionsVersion = 0;

	constructor(private readonly options: SessionWorkspaceStateOptions) {
		this.#activity = new SessionActivityController({
			isSessionObserved: options.isSessionObserved,
			getSessions: () => this.sessions,
			getActiveOutputSessionId: () => this.activeOutputSessionId,
			setActiveOutputSessionId: (sessionId) => this.activeOutputSessionId = sessionId,
			getUnreadSessionIds: () => this.unreadSessionIds,
			setUnreadSessionIds: (sessionIds) => this.unreadSessionIds = sessionIds,
			getActivityOrder: () => this.activityOrder,
			setActivityOrder: (order) => this.activityOrder = order,
			updateSessionOutput: (sessionId, timestamp) => {
				const session = this.sessions.find((item) => item.id === sessionId);
				if (!session) return;
				const lastOutputAt = maxTimestamp(session.lastOutputAt, timestamp);
				if (lastOutputAt === session.lastOutputAt) return;
				this.sessions = this.sessions.map((item) => sessionId === item.id ? { ...item, lastOutputAt } : item);
			}
		});
	}

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

		const next = {
			...previous,
			...changes,
			id: sessionId,
			lastActiveAt: Math.max(previous.lastActiveAt, changes.lastActiveAt ?? previous.lastActiveAt),
			lastOutputAt: maxTimestamp(changes.lastOutputAt ?? previous.lastOutputAt, previous.lastOutputAt)
		};
		if ('notePreview' in changes && changes.notePreview !== previous.notePreview) this.#sessionNotes.delete(sessionId);
		const nextSessions = this.sessions.map((session) => session.id === sessionId ? next : session);
		this.#activity.applySessionUpdated(previous, next, nextSessions, this.sessionsLoaded);
		this.sessions = nextSessions;
		this.syncManualSessionOrder();
	}

	applySessionRemoved(sessionId: string) {
		if (!this.sessions.some((session) => session.id === sessionId)) return;
		this.sessions = this.sessions.filter((session) => session.id !== sessionId);
		this.#sessionNotes.delete(sessionId);
		this.#sessionNoteRequests.delete(sessionId);
		this.#activity.removeSession(sessionId);
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
			if (previous && previous.notePreview !== session.notePreview) this.#sessionNotes.delete(session.id);
			return {
				...session,
				lastActiveAt: Math.max(session.lastActiveAt, previous?.lastActiveAt ?? 0),
				lastOutputAt: maxTimestamp(session.lastOutputAt, previous?.lastOutputAt ?? null)
			};
		});

		this.sessions = nextSessions;
		this.#activity.applySessions([...previousSessions.values()], nextSessions, this.sessionsLoaded);
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
			this.#activity.rebuild(this.sessions);
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
		const normalizedNote = note.trim();
		const data = await requestJson<{ notePreview: string }>(`/api/sessions/${encodeURIComponent(sessionId)}/note`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ note: normalizedNote })
		});
		this.#sessionNotes.set(sessionId, normalizedNote);
		this.sessions = this.sessions.map((session) => session.id === sessionId ? { ...session, notePreview: data.notePreview } : session);
	}

	async loadSessionNote(sessionId: string): Promise<string> {
		const cached = this.#sessionNotes.get(sessionId);
		if (cached !== undefined) return cached;
		const pending = this.#sessionNoteRequests.get(sessionId);
		if (pending) return pending;

		const request = requestJson<{ note: string }>(`/api/sessions/${encodeURIComponent(sessionId)}/note`, { cache: 'no-store' })
			.then(({ note }) => {
				this.#sessionNotes.set(sessionId, note);
				return note;
			})
			.finally(() => {
				if (this.#sessionNoteRequests.get(sessionId) === request) this.#sessionNoteRequests.delete(sessionId);
			});
		this.#sessionNoteRequests.set(sessionId, request);
		return request;
	}

	restoreBrowserPreferences(storage: Storage) {
		const savedOrderMode = storage.getItem(SESSION_ORDER_MODE_KEY);
		if (savedOrderMode === 'activity' || savedOrderMode === 'manual') this.sessionOrderMode = savedOrderMode;
		else if (savedOrderMode === 'recent') {
			this.sessionOrderMode = 'activity';
			storage.setItem(SESSION_ORDER_MODE_KEY, 'activity');
		}
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
		this.#activity.recordSessionOutput(sessionId, active, timestamp, observed);
	}

	markSessionObserved(sessionId: string, timestamp = Date.now()) {
		this.#activity.markSessionObserved(sessionId, timestamp);
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
			this.#activity.rebuild(this.sessions);
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
			this.#activity.clearOutputActivity(session.id);
			this.markSessionObserved(session.id);
			this.#activity.rebuild(this.sessions);
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
			this.#activity.removeSession(session.id);
			this.manualSessionOrder = this.manualSessionOrder.filter((id) => id !== session.id);
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
		this.#activity.reset();
		this.sessions = [];
		this.requestedSessionId = undefined;
		this.#sessionNotes.clear();
		this.#sessionNoteRequests.clear();
		this.sessionsLoaded = false;
		this.newSessionOpen = false;
		this.errorMessage = '';
		this.sessionActionError = '';
	}

	dispose() {
		this.clearAllInputActivity();
		this.#activity.dispose();
		this.#sessionNotes.clear();
		this.#sessionNoteRequests.clear();
	}

	private invalidateSessions() {
		this.#sessionsVersion += 1;
		this.#refreshQueued = true;
	}

	private clearAllInputActivity() {
		for (const timer of this.#activityRequestTimers.values()) window.clearTimeout(timer);
		this.#activityRequestTimers.clear();
	}

	private persistManualSessionOrder() {
		window.localStorage.setItem(SESSION_ORDER_KEY, JSON.stringify(this.manualSessionOrder));
	}

	private syncManualSessionOrder() {
		const nextOrder = reconcileSessionOrder(this.sessions, this.manualSessionOrder);
		if (nextOrder.join('\0') === this.manualSessionOrder.join('\0')) return;
		this.manualSessionOrder = nextOrder;
		this.persistManualSessionOrder();
	}
}
