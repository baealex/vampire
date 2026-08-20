import { isUnauthorized, requestJson } from '$lib/client/request';
import {
	maxTimestamp,
	reconcileSessionOrder,
	sortSessions,
	type SessionActivityRecord
} from './view.ts';
import { SessionActivityController } from './activity-controller.ts';
import { BackgroundTerminalReconciler } from './background-terminal-reconciler.ts';
import type {
	LaunchProfile,
	ManagedSession,
	SessionOrderMode,
	SessionTerminal,
	WorkspacePreferences
} from './types.ts';

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
	launchProfiles = $state<LaunchProfile[]>([]);
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
	startingBackgroundSessionId = $state<string | undefined>(undefined);
	stoppingBackgroundProcessId = $state<string | undefined>(undefined);
	updatingFavoriteCommand = $state<string | undefined>(undefined);
	backgroundActionError = $state('');
	backgroundActionErrorSessionId = $state<string | undefined>(undefined);
	sessionOrderMode = $state<SessionOrderMode>('activity');
	manualSessionOrder = $state<string[]>([]);
	workspacePreferencesError = $state('');
	activityOrder = $state<string[]>([]);
	activityRecords = $state<Map<string, SessionActivityRecord>>(new Map());

	displayedSessions = $derived(sortSessions(
		this.sessions,
		this.sessionOrderMode,
		this.manualSessionOrder,
		this.activityOrder
	));
	shortcutSessions = $derived(this.displayedSessions.filter((session) => session.state === 'running'));
	activeSession = $derived(
		this.requestedSessionId
			? this.sessions.find((session) => session.id === this.requestedSessionId)
			: undefined
	);
	hasOpenSession = $derived(Boolean(this.activeSession || this.requestedSessionId));

	#activityRequestTimers = new Map<string, number>();
	#activity: SessionActivityController;
	#backgroundTerminals = new BackgroundTerminalReconciler();
	#sessionNotes = new Map<string, string>();
	#sessionNoteRequests = new Map<string, Promise<string>>();
	#refreshPromise: Promise<void> | undefined;
	#refreshQueued = false;
	#sessionsVersion = 0;
	#legacyPreferenceStorage: Storage | undefined;
	#preferencesInitialized = false;
	#preferenceWriteQueue: Promise<void> = Promise.resolve();
	#preferenceMutationVersion = 0;
	#pendingPreferenceWrites = 0;
	readonly #options: SessionWorkspaceStateOptions;

	constructor(options: SessionWorkspaceStateOptions) {
		this.#options = options;
		this.#activity = new SessionActivityController({
			isSessionObserved: options.isSessionObserved,
			getSessions: () => this.sessions,
			getActivityRecords: () => this.activityRecords,
			setActivityRecords: (records) => this.activityRecords = records,
			getActivityOrder: () => this.activityOrder,
			setActivityOrder: (order) => this.activityOrder = order,
			updateSessionOutput: (sessionId, timestamp) => {
				const session = this.sessions.find((item) => item.id === sessionId);
				if (!session) return;
				const lastOutputAt = maxTimestamp(session.lastOutputAt, timestamp);
				const mainTerminal = session.terminals[0];
				const mainLastOutputAt = maxTimestamp(mainTerminal?.lastOutputAt ?? null, timestamp);
				if (lastOutputAt === session.lastOutputAt && mainLastOutputAt === mainTerminal?.lastOutputAt) return;
				this.sessions = this.sessions.map((item) => sessionId === item.id
					? {
						...item,
						lastOutputAt,
						terminals: mainTerminal
							? item.terminals.map((terminal, index) => index === 0 ? { ...terminal, lastOutputAt: mainLastOutputAt } : terminal)
							: item.terminals
					}
					: item);
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

	applyLaunchProfiles(launchProfiles: LaunchProfile[]) {
		this.launchProfiles = launchProfiles.map((profile) => ({ ...profile }));
		const profileIds = new Set(this.launchProfiles.map((profile) => profile.id));
		this.sessions = this.sessions.map((session) => session.startupProfileId && !profileIds.has(session.startupProfileId)
			? { ...session, startupProfileId: null }
			: session);
	}

	applyWorkspacePreferences(preferences: WorkspacePreferences | null) {
		if (preferences === null) {
			if (this.#preferencesInitialized || this.#pendingPreferenceWrites > 0) return;
			this.#preferencesInitialized = true;
			this.syncManualSessionOrder();
			this.persistWorkspacePreferences();
			return;
		}
		if (this.#pendingPreferenceWrites > 0) return;
		this.acceptWorkspacePreferences(preferences);
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

		const nextState = changes.state ?? previous.state;
		if (nextState === 'missing') this.#backgroundTerminals.clearSession(sessionId);
		const terminals = changes.terminals && nextState === 'running'
			? this.#backgroundTerminals.reconcile(sessionId, changes.terminals)
			: (
				changes.terminals ?? (
					typeof changes.lastOutputAt === 'number' && previous.terminals.length > 0
						? previous.terminals.map((terminal, index) => index === 0
							? { ...terminal, lastOutputAt: maxTimestamp(terminal.lastOutputAt, changes.lastOutputAt ?? null) }
							: terminal)
						: previous.terminals
				)
			);
		const next = {
			...previous,
			...changes,
			id: sessionId,
			terminals,
			lastActiveAt: Math.max(previous.lastActiveAt, changes.lastActiveAt ?? previous.lastActiveAt),
			lastOutputAt: maxTimestamp(changes.lastOutputAt ?? previous.lastOutputAt, previous.lastOutputAt)
		};
		if ('notePreview' in changes && changes.notePreview !== previous.notePreview) this.#sessionNotes.delete(sessionId);
		const nextSessions = this.sessions.map((session) => session.id === sessionId ? next : session);
		this.sessions = nextSessions;
		this.#activity.applySessionUpdated(previous, next, nextSessions, this.sessionsLoaded);
		this.syncManualSessionOrder();
	}

	applySessionRemoved(sessionId: string) {
		this.#backgroundTerminals.clearSession(sessionId);
		if (!this.sessions.some((session) => session.id === sessionId)) return;
		this.sessions = this.sessions.filter((session) => session.id !== sessionId);
		this.#sessionNotes.delete(sessionId);
		this.#sessionNoteRequests.delete(sessionId);
		this.#activity.removeSession(sessionId);
		if (this.backgroundActionErrorSessionId === sessionId) {
			this.backgroundActionError = '';
			this.backgroundActionErrorSessionId = undefined;
		}
		this.syncManualSessionOrder();
	}

	async #runRefreshLoop() {
		do {
			this.#refreshQueued = false;
			const requestVersion = this.#sessionsVersion;
			this.errorMessage = '';
			try {
				const data = await requestJson<{
					sessions: ManagedSession[];
					preferences?: WorkspacePreferences | null;
					launchProfiles?: LaunchProfile[];
				}>('/api/sessions');
				if (requestVersion !== this.#sessionsVersion) continue;
				this.applySessions(data.sessions);
				if (data.preferences !== undefined) this.applyWorkspacePreferences(data.preferences);
				if (data.launchProfiles !== undefined) this.applyLaunchProfiles(data.launchProfiles);
			} catch (error) {
				if (requestVersion !== this.#sessionsVersion) continue;
				if (isUnauthorized(error)) this.#options.onUnauthorized();
				else this.errorMessage = error instanceof Error ? error.message : 'Unable to load sessions';
			}
		} while (this.#refreshQueued);
	}

	private applySessions(incomingSessions: ManagedSession[]) {
		const previousSessions = new Map(this.sessions.map((session) => [session.id, session]));
		const incomingSessionIds = new Set(incomingSessions.map((session) => session.id));
		for (const sessionId of previousSessions.keys()) {
			if (!incomingSessionIds.has(sessionId)) this.#backgroundTerminals.clearSession(sessionId);
		}
		const nextSessions = incomingSessions.map((session) => {
			const previous = previousSessions.get(session.id);
			if (previous && previous.notePreview !== session.notePreview) this.#sessionNotes.delete(session.id);
			if (session.state === 'missing') this.#backgroundTerminals.clearSession(session.id);
			return {
				...session,
				terminals: session.state === 'running'
					? this.#backgroundTerminals.reconcile(session.id, session.terminals)
					: session.terminals,
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
			this.sessions = [...this.sessions.filter((session) => session.id !== data.session.id), data.session];
			this.#activity.rebuild(this.sessions);
			this.manualSessionOrder = [...this.manualSessionOrder.filter((id) => id !== data.session.id), data.session.id];
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

	async createIsolatedWorkspace(
		sourceSessionId: string,
		name: string,
		tmuxAvailable?: boolean
	): Promise<{ ok: boolean; error?: string }> {
		if (tmuxAvailable === false) {
			return { ok: false, error: 'Install tmux on the server computer before starting a session.' };
		}

		try {
			const data = await requestJson<{ session: ManagedSession }>(
				`/api/sessions/${encodeURIComponent(sourceSessionId)}/worktrees`,
				{
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ name })
				},
				'Unable to create the isolated workspace'
			);
			this.invalidateSessions();
			this.sessions = [...this.sessions.filter((session) => session.id !== data.session.id), data.session];
			this.#activity.rebuild(this.sessions);
			this.manualSessionOrder = [...this.manualSessionOrder.filter((id) => id !== data.session.id), data.session.id];
			this.openSession(data.session);
			void this.refresh({ quiet: true });
			return { ok: true };
		} catch (error) {
			if (isUnauthorized(error)) this.#options.onUnauthorized();
			return {
				ok: false,
				error: error instanceof Error ? error.message : 'Unable to create the isolated workspace'
			};
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

	async updateWorkspaceAlias(
		sessionId: string,
		alias: string
	): Promise<{ ok: boolean; error?: string }> {
		try {
			const data = await requestJson<{ alias: string | null }>(
				`/api/sessions/${encodeURIComponent(sessionId)}/alias`,
				{
					method: 'PUT',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ alias })
				},
				'Unable to save the workspace alias'
			);
			this.sessions = this.sessions.map((session) => session.id === sessionId
				? { ...session, workspaceLabel: data.alias ?? '' }
				: session);
			return { ok: true };
		} catch (error) {
			if (isUnauthorized(error)) this.#options.onUnauthorized();
			return {
				ok: false,
				error: error instanceof Error ? error.message : 'Unable to save the workspace alias'
			};
		}
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

	async updateWorkspaceStartup(
		sessionId: string,
		launchProfiles: LaunchProfile[],
		startupProfileId: string | null
	): Promise<{ ok: boolean; error?: string }> {
		try {
			const data = await requestJson<{
				launchProfiles: LaunchProfile[];
				startupProfileId: string | null;
				clearedSessionIds: string[];
			}>(
				`/api/sessions/${encodeURIComponent(sessionId)}/startup-profile`,
				{
					method: 'PUT',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ launchProfiles, startupProfileId })
				},
				'Unable to save the startup profile'
			);
			this.applyLaunchProfiles(data.launchProfiles);
			const clearedSessionIds = new Set(data.clearedSessionIds);
			this.sessions = this.sessions.map((session) => session.id === sessionId
				? { ...session, startupProfileId: data.startupProfileId }
				: clearedSessionIds.has(session.id)
					? { ...session, startupProfileId: null }
					: session);
			return { ok: true };
		} catch (error) {
			if (isUnauthorized(error)) this.#options.onUnauthorized();
			return { ok: false, error: error instanceof Error ? error.message : 'Unable to save the startup profile' };
		}
	}

	async startBackgroundProcess(sessionId: string, command: string): Promise<SessionTerminal | undefined> {
		if (this.startingBackgroundSessionId || this.stoppingBackgroundProcessId) return undefined;
		this.startingBackgroundSessionId = sessionId;
		this.backgroundActionError = '';
		this.backgroundActionErrorSessionId = undefined;
		try {
			const data = await requestJson<{ backgroundProcess: SessionTerminal }>(
				`/api/sessions/${encodeURIComponent(sessionId)}/background`,
				{
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ command })
				},
				'Unable to start the background command'
			);
			this.sessions = this.sessions.map((session) => session.id === sessionId
				? {
					...session,
					terminals: this.#backgroundTerminals.applyStarted(
						sessionId,
						session.terminals,
						data.backgroundProcess
					)
				}
				: session);
			return data.backgroundProcess;
		} catch (error) {
			if (isUnauthorized(error)) this.#options.onUnauthorized();
			this.backgroundActionError = error instanceof Error ? error.message : 'Unable to start the background command';
			this.backgroundActionErrorSessionId = sessionId;
			return undefined;
		} finally {
			this.startingBackgroundSessionId = undefined;
		}
	}

	async stopBackgroundProcess(sessionId: string, processId: string): Promise<boolean> {
		if (this.startingBackgroundSessionId || this.stoppingBackgroundProcessId) return false;
		this.stoppingBackgroundProcessId = processId;
		this.backgroundActionError = '';
		this.backgroundActionErrorSessionId = undefined;
		try {
			await requestJson<{ ok: boolean }>(
				`/api/sessions/${encodeURIComponent(sessionId)}/background/${encodeURIComponent(processId)}`,
				{ method: 'DELETE' },
				'Unable to stop the background process'
			);
			this.sessions = this.sessions.map((session) => session.id === sessionId
				? {
					...session,
					terminals: this.#backgroundTerminals.applyStopped(sessionId, session.terminals, processId)
				}
				: session);
			return true;
		} catch (error) {
			if (isUnauthorized(error)) this.#options.onUnauthorized();
			this.backgroundActionError = error instanceof Error ? error.message : 'Unable to stop the background process';
			this.backgroundActionErrorSessionId = sessionId;
			return false;
		} finally {
			this.stoppingBackgroundProcessId = undefined;
		}
	}

	async loadBackgroundOutput(sessionId: string, processId: string): Promise<string> {
		const data = await requestJson<{ output: string }>(
			`/api/sessions/${encodeURIComponent(sessionId)}/background/${encodeURIComponent(processId)}/output`,
			{ cache: 'no-store' },
			'Unable to read the background output'
		);
		return data.output;
	}

	async favoriteBackgroundCommand(sessionId: string, command: string): Promise<boolean> {
		if (this.updatingFavoriteCommand) return false;
		this.updatingFavoriteCommand = command;
		this.backgroundActionError = '';
		this.backgroundActionErrorSessionId = undefined;
		try {
			const data = await requestJson<{ favoriteCommands: string[] }>(
				`/api/sessions/${encodeURIComponent(sessionId)}/background/favorites`,
				{
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ command })
				},
				'Unable to save the favorite command'
			);
			this.sessions = this.sessions.map((session) => session.id === sessionId
				? { ...session, favoriteCommands: data.favoriteCommands }
				: session);
			return true;
		} catch (error) {
			if (isUnauthorized(error)) this.#options.onUnauthorized();
			this.backgroundActionError = error instanceof Error ? error.message : 'Unable to save the favorite command';
			this.backgroundActionErrorSessionId = sessionId;
			return false;
		} finally {
			this.updatingFavoriteCommand = undefined;
		}
	}

	async removeBackgroundCommandFavorite(sessionId: string, command: string): Promise<boolean> {
		if (this.updatingFavoriteCommand) return false;
		this.updatingFavoriteCommand = command;
		this.backgroundActionError = '';
		this.backgroundActionErrorSessionId = undefined;
		try {
			const data = await requestJson<{ favoriteCommands: string[] }>(
				`/api/sessions/${encodeURIComponent(sessionId)}/background/favorites`,
				{
					method: 'DELETE',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ command })
				},
				'Unable to remove the favorite command'
			);
			this.sessions = this.sessions.map((session) => session.id === sessionId
				? { ...session, favoriteCommands: data.favoriteCommands }
				: session);
			return true;
		} catch (error) {
			if (isUnauthorized(error)) this.#options.onUnauthorized();
			this.backgroundActionError = error instanceof Error ? error.message : 'Unable to remove the favorite command';
			this.backgroundActionErrorSessionId = sessionId;
			return false;
		} finally {
			this.updatingFavoriteCommand = undefined;
		}
	}

	restoreBrowserPreferences(storage: Storage) {
		this.#activity.restoreBrowserPreferences(storage);
		this.#legacyPreferenceStorage = storage;
		const savedMode = storage.getItem(SESSION_ORDER_MODE_KEY);
		if (savedMode === 'activity' || savedMode === 'manual') this.sessionOrderMode = savedMode;
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
		const changed = this.sessionOrderMode !== mode;
		const needsInitialization = !this.#preferencesInitialized;
		this.#preferencesInitialized = true;
		this.sessionOrderMode = mode;
		if (mode === 'manual') this.syncManualSessionOrder();
		if (changed || needsInitialization) this.persistWorkspacePreferences();
	}

	reorderSession(draggedId: string, targetId: string, position: 'before' | 'after') {
		if (draggedId === targetId) return;
		const order = this.displayedSessions.map((session) => session.id).filter((id) => id !== draggedId);
		const targetIndex = order.indexOf(targetId);
		if (targetIndex < 0) return;
		order.splice(targetIndex + (position === 'after' ? 1 : 0), 0, draggedId);
		this.manualSessionOrder = order;
		this.#preferencesInitialized = true;
		this.persistWorkspacePreferences();
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

	markSessionObserved(sessionId: string) {
		this.#activity.markSessionObserved(sessionId);
	}

	openSession(session: ManagedSession) {
		const previousSessionId = this.requestedSessionId;
		if (
			previousSessionId
			&& previousSessionId !== session.id
			&& this.#options.isSessionObserved(previousSessionId)
		) {
			this.markSessionObserved(previousSessionId);
		}
		if (this.activeSession?.id === session.id && this.requestedSessionId === session.id) return;
		this.requestedSessionId = session.id;
		this.sessionActionError = '';
		this.#options.navigate(`/sessions/${encodeURIComponent(session.id)}`);
	}

	clearActiveSession() {
		if (this.requestedSessionId && this.#options.isSessionObserved(this.requestedSessionId)) {
			this.markSessionObserved(this.requestedSessionId);
		}
		this.requestedSessionId = undefined;
		this.sessionActionError = '';
		this.#options.navigate('/');
	}

	syncLocation(pathname: string) {
		const match = /^\/sessions\/([^/]+)\/?$/.exec(pathname);
		const nextSessionId = match ? decodeURIComponent(match[1]) : undefined;
		if (
			this.requestedSessionId
			&& this.requestedSessionId !== nextSessionId
			&& this.#options.isSessionObserved(this.requestedSessionId)
		) {
			this.markSessionObserved(this.requestedSessionId);
		}
		this.requestedSessionId = nextSessionId;
		if (this.requestedSessionId && this.#options.isSessionObserved(this.requestedSessionId)) {
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
			this.#backgroundTerminals.clearSession(session.id);
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
			this.#backgroundTerminals.clearSession(session.id);
			this.invalidateSessions();
			this.sessions = this.sessions.map((item) => item.id === session.id
				? { ...item, state: 'missing', lastOutputAt: null, attachedClients: 0, foregroundProcess: null, terminals: [] }
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
		this.backgroundActionError = '';
		this.backgroundActionErrorSessionId = undefined;
		try {
			await requestJson<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(session.id)}?terminate=true`, { method: 'DELETE' });
			this.#backgroundTerminals.clearSession(session.id);
			this.invalidateSessions();
			this.sessions = this.sessions.filter((item) => item.id !== session.id);
			this.#activity.removeSession(session.id);
			this.manualSessionOrder = this.manualSessionOrder.filter((id) => id !== session.id);
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
		this.#backgroundTerminals.clear();
		this.sessions = [];
		this.launchProfiles = [];
		this.requestedSessionId = undefined;
		this.#sessionNotes.clear();
		this.#sessionNoteRequests.clear();
		this.sessionsLoaded = false;
		this.newSessionOpen = false;
		this.errorMessage = '';
		this.sessionActionError = '';
		this.startingBackgroundSessionId = undefined;
		this.stoppingBackgroundProcessId = undefined;
		this.updatingFavoriteCommand = undefined;
		this.backgroundActionError = '';
		this.backgroundActionErrorSessionId = undefined;
		this.sessionOrderMode = 'activity';
		this.manualSessionOrder = [];
		this.workspacePreferencesError = '';
		this.#preferencesInitialized = false;
		this.#preferenceMutationVersion += 1;
	}

	dispose() {
		this.clearAllInputActivity();
		this.#activity.dispose();
		this.#backgroundTerminals.clear();
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

	private acceptWorkspacePreferences(preferences: WorkspacePreferences) {
		this.#preferencesInitialized = true;
		this.sessionOrderMode = preferences.sessionOrderMode;
		this.manualSessionOrder = reconcileSessionOrder(this.sessions, preferences.manualSessionOrder);
		this.workspacePreferencesError = '';
		this.#legacyPreferenceStorage?.removeItem(SESSION_ORDER_MODE_KEY);
		this.#legacyPreferenceStorage?.removeItem(SESSION_ORDER_KEY);
	}

	private persistWorkspacePreferences() {
		const preferences: WorkspacePreferences = {
			sessionOrderMode: this.sessionOrderMode,
			manualSessionOrder: reconcileSessionOrder(this.sessions, this.manualSessionOrder)
		};
		this.manualSessionOrder = preferences.manualSessionOrder;
		const mutationVersion = ++this.#preferenceMutationVersion;
		this.#pendingPreferenceWrites += 1;
		this.workspacePreferencesError = '';
		this.#preferenceWriteQueue = this.#preferenceWriteQueue.then(async () => {
			let savedPreferences: WorkspacePreferences | undefined;
			try {
				const data = await requestJson<{ preferences: WorkspacePreferences }>(
					'/api/workspace-preferences',
					{
						method: 'PUT',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify(preferences)
					},
					'Unable to sync workspace order'
				);
				savedPreferences = data.preferences;
			} catch (error) {
				if (isUnauthorized(error)) this.#options.onUnauthorized();
				if (mutationVersion === this.#preferenceMutationVersion) {
					this.workspacePreferencesError = error instanceof Error
						? error.message
						: 'Unable to sync workspace order';
				}
			} finally {
				this.#pendingPreferenceWrites -= 1;
			}
			if (savedPreferences && mutationVersion === this.#preferenceMutationVersion) {
				this.acceptWorkspacePreferences(savedPreferences);
			}
		});
	}

	private syncManualSessionOrder() {
		const nextOrder = reconcileSessionOrder(this.sessions, this.manualSessionOrder);
		if (nextOrder.join('\0') === this.manualSessionOrder.join('\0')) return;
		this.manualSessionOrder = nextOrder;
	}
}
