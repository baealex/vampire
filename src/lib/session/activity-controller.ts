import {
	buildActivityOrder,
	sessionOutputSettleMs,
	sessionTrackedOutputAt,
	type SessionActivityRecord,
	type SessionActivityRecords
} from './view.ts';
import type { ManagedSession } from './types.ts';

const OUTPUT_ACTIVITY_UPDATE_INTERVAL_MS = 500;
const SESSION_OUTPUT_SEEN_KEY = 'vampire:session-output-seen';
const SESSION_OUTPUT_SEEN_VERSION = 1;

type SessionOutputSeenState = {
	version: typeof SESSION_OUTPUT_SEEN_VERSION;
	sessions: Record<string, number>;
};

type SessionActivityControllerOptions = {
	isSessionObserved: (sessionId: string) => boolean;
	getSessions: () => ManagedSession[];
	getActivityRecords: () => SessionActivityRecords;
	setActivityRecords: (records: Map<string, SessionActivityRecord>) => void;
	getActivityOrder: () => string[];
	setActivityOrder: (order: string[]) => void;
	updateSessionOutput: (sessionId: string, timestamp: number) => void;
};

export interface SessionActivityScheduler {
	now: () => number;
	setTimeout: (callback: () => void, delay: number) => number;
	clearTimeout: (timer: number) => void;
}

function browserScheduler(): SessionActivityScheduler {
	return {
		now: () => Date.now(),
		setTimeout: (callback, delay) => window.setTimeout(callback, delay),
		clearTimeout: (timer) => window.clearTimeout(timer)
	};
}

function outputTimestampChanged(previous: number | null, next: number | null): next is number {
	return next !== null && next > (previous ?? 0);
}

export class SessionActivityController {
	#lastOutputActivityUpdate = new Map<string, number>();
	#outputActivityTimers = new Map<string, number>();
	#activeExpiryTimers = new Map<string, number>();
	#pendingOutputActivity = new Map<string, number>();
	#storage: Storage | undefined;
	readonly #options: SessionActivityControllerOptions;
	readonly #scheduler: SessionActivityScheduler;

	constructor(options: SessionActivityControllerOptions, scheduler = browserScheduler()) {
		this.#options = options;
		this.#scheduler = scheduler;
	}

	restoreBrowserPreferences(storage: Storage) {
		this.#storage = storage;
		let saved: unknown;
		try {
			saved = JSON.parse(storage.getItem(SESSION_OUTPUT_SEEN_KEY) ?? 'null');
		} catch {
			return;
		}
		if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return;
		const state = saved as Partial<SessionOutputSeenState>;
		if (state.version !== SESSION_OUTPUT_SEEN_VERSION || !state.sessions || typeof state.sessions !== 'object') return;
		const nextRecords = new Map(this.#options.getActivityRecords());
		for (const [sessionId, timestamp] of Object.entries(state.sessions)) {
			if (!Number.isFinite(timestamp) || timestamp < 0) continue;
			const current = nextRecords.get(sessionId) ?? { activeUntil: 0, seenThroughAt: 0 };
			nextRecords.set(sessionId, {
				...current,
				seenThroughAt: Math.max(current.seenThroughAt, timestamp)
			});
		}
		this.#options.setActivityRecords(nextRecords);
	}

	applySessions(previousSessions: ManagedSession[], nextSessions: ManagedSession[], sessionsLoaded: boolean) {
		const previousById = new Map(previousSessions.map((session) => [session.id, session]));
		for (const session of nextSessions) {
			const previous = previousById.get(session.id);
			if (!previous) {
				this.#initializeSession(session);
				continue;
			}
			const outputAt = sessionTrackedOutputAt(session);
			if (sessionsLoaded && outputTimestampChanged(sessionTrackedOutputAt(previous), outputAt)) {
				if (this.#options.isSessionObserved(session.id)) {
					this.#markOutputSeen(session.id, outputAt);
				} else {
					this.#startOutputActivity(
						session.id,
						outputAt,
						false,
						sessionOutputSettleMs(session)
					);
				}
			}
			if (previous.agentState !== 'waiting' && session.agentState === 'waiting') {
				this.clearOutputActivity(session.id);
			}
		}
		this.#pruneSessions(nextSessions);
		this.#rebuildActivityOrder(nextSessions);
	}

	applySessionUpdated(
		previous: ManagedSession,
		next: ManagedSession,
		nextSessions: ManagedSession[],
		sessionsLoaded: boolean
	) {
		const outputAt = sessionTrackedOutputAt(next);
		const outputChanged = sessionsLoaded && outputTimestampChanged(sessionTrackedOutputAt(previous), outputAt);
		const observed = this.#options.isSessionObserved(next.id);
		if (outputChanged && outputAt !== null) {
			if (observed) this.#markOutputSeen(next.id, outputAt);
			else {
				this.#startOutputActivity(
					next.id,
					outputAt,
					false,
					sessionOutputSettleMs(next)
				);
			}
		}
		if (previous.agentState !== 'waiting' && next.agentState === 'waiting') {
			this.clearOutputActivity(next.id);
		}
		if (outputChanged || previous.state !== next.state || previous.agentState !== next.agentState) {
			this.#rebuildActivityOrder(nextSessions);
		}
	}

	recordSessionOutput(sessionId: string, active: boolean, timestamp?: number, observed = false) {
		if (!active) {
			this.#flushOutputActivity(sessionId);
			return;
		}

		const outputTimestamp = timestamp ?? this.#scheduler.now();
		const session = this.#options.getSessions().find((item) => item.id === sessionId);
		if (!session) return;
		this.#startOutputActivity(sessionId, outputTimestamp, observed, sessionOutputSettleMs(session));
		this.#recordOutputActivity(sessionId, outputTimestamp);
	}

	markSessionObserved(sessionId: string) {
		const session = this.#options.getSessions().find((item) => item.id === sessionId);
		if (!session) return;
		const current = this.#recordFor(sessionId);
		const nextSeenThroughAt = Math.max(current.seenThroughAt, sessionTrackedOutputAt(session) ?? 0, this.#scheduler.now());
		if (nextSeenThroughAt === current.seenThroughAt) return;
		this.#setRecord(sessionId, { ...current, seenThroughAt: nextSeenThroughAt });
		this.#persistSeenOutput();
		this.#rebuildActivityOrder();
	}

	removeSession(sessionId: string) {
		this.#clearTimers(sessionId);
		this.#pendingOutputActivity.delete(sessionId);
		this.#lastOutputActivityUpdate.delete(sessionId);
		this.#removeRecord(sessionId);
		this.#persistSeenOutput();
		this.#removeSessionActivity(sessionId);
	}

	rebuild(sessions = this.#options.getSessions()) {
		for (const session of sessions) this.#initializeSession(session);
		this.#rebuildActivityOrder(sessions);
	}

	clearOutputActivity(sessionId: string) {
		this.#clearTimers(sessionId);
		this.#pendingOutputActivity.delete(sessionId);
		this.#lastOutputActivityUpdate.delete(sessionId);
		const current = this.#recordFor(sessionId);
		this.#setRecord(sessionId, { ...current, activeUntil: 0 });
	}

	reset() {
		this.#clearAllTimers();
		this.#options.setActivityOrder([]);
		this.#options.setActivityRecords(new Map([...this.#options.getActivityRecords()].map(([sessionId, record]) => [
			sessionId,
			{ ...record, activeUntil: 0 }
		])));
	}

	dispose() {
		this.#clearAllTimers();
		this.#options.setActivityOrder([]);
		this.#options.setActivityRecords(new Map());
	}

	#initializeSession(session: ManagedSession) {
		if (this.#options.getActivityRecords().has(session.id)) return;
		this.#setRecord(session.id, {
			activeUntil: 0,
			seenThroughAt: sessionTrackedOutputAt(session) ?? 0
		});
		this.#persistSeenOutput();
	}

	#markOutputSeen(sessionId: string, outputTimestamp: number) {
		const current = this.#recordFor(sessionId);
		const changed = this.#setRecord(sessionId, {
			...current,
			seenThroughAt: Math.max(current.seenThroughAt, outputTimestamp)
		});
		if (changed) this.#persistSeenOutput();
	}

	#startOutputActivity(
		sessionId: string,
		outputTimestamp: number,
		observed: boolean,
		settleDelay: number
	) {
		const session = this.#options.getSessions().find((item) => item.id === sessionId);
		if (!session || session.state === 'missing') return;

		const current = this.#recordFor(sessionId);
		const next: SessionActivityRecord = {
			activeUntil: Math.max(current.activeUntil, this.#scheduler.now() + Math.max(0, settleDelay)),
			seenThroughAt: observed ? Math.max(current.seenThroughAt, outputTimestamp) : current.seenThroughAt
		};
		const changed = this.#setRecord(sessionId, next);
		if (changed && observed) this.#persistSeenOutput();
		this.#scheduleActiveExpiry(sessionId, next.activeUntil);
		if (changed) this.#rebuildActivityOrder();
	}

	#recordOutputActivity(sessionId: string, timestamp: number) {
		const now = this.#scheduler.now();
		const elapsed = now - (this.#lastOutputActivityUpdate.get(sessionId) ?? -Infinity);
		if (elapsed >= OUTPUT_ACTIVITY_UPDATE_INTERVAL_MS) {
			const scheduledTimer = this.#outputActivityTimers.get(sessionId);
			if (scheduledTimer !== undefined) this.#scheduler.clearTimeout(scheduledTimer);
			this.#outputActivityTimers.delete(sessionId);
			this.#commitOutputActivity(sessionId, timestamp, now);
			return;
		}

		this.#pendingOutputActivity.set(sessionId, timestamp);
		if (this.#outputActivityTimers.has(sessionId)) return;
		this.#outputActivityTimers.set(sessionId, this.#scheduler.setTimeout(() => {
			this.#outputActivityTimers.delete(sessionId);
			const pendingTimestamp = this.#pendingOutputActivity.get(sessionId);
			if (pendingTimestamp !== undefined) this.#commitOutputActivity(sessionId, pendingTimestamp, this.#scheduler.now());
		}, OUTPUT_ACTIVITY_UPDATE_INTERVAL_MS - elapsed));
	}

	#flushOutputActivity(sessionId: string) {
		const timer = this.#outputActivityTimers.get(sessionId);
		if (timer !== undefined) this.#scheduler.clearTimeout(timer);
		this.#outputActivityTimers.delete(sessionId);
		const pendingTimestamp = this.#pendingOutputActivity.get(sessionId);
		if (pendingTimestamp !== undefined) this.#commitOutputActivity(sessionId, pendingTimestamp, this.#scheduler.now());
	}

	#commitOutputActivity(sessionId: string, timestamp: number, recordedAt: number) {
		this.#pendingOutputActivity.delete(sessionId);
		this.#lastOutputActivityUpdate.set(sessionId, recordedAt);
		this.#options.updateSessionOutput(sessionId, timestamp);
	}

	#scheduleActiveExpiry(sessionId: string, activeUntil: number) {
		const existingTimer = this.#activeExpiryTimers.get(sessionId);
		if (existingTimer !== undefined) this.#scheduler.clearTimeout(existingTimer);
		this.#activeExpiryTimers.set(sessionId, this.#scheduler.setTimeout(() => {
			this.#activeExpiryTimers.delete(sessionId);
			const current = this.#options.getActivityRecords().get(sessionId);
			if (!current || current.activeUntil !== activeUntil) return;
			this.#setRecord(sessionId, { ...current, activeUntil: 0 });
			this.#rebuildActivityOrder();
		}, Math.max(0, activeUntil - this.#scheduler.now())));
	}

	#recordFor(sessionId: string): SessionActivityRecord {
		return this.#options.getActivityRecords().get(sessionId) ?? { activeUntil: 0, seenThroughAt: 0 };
	}

	#setRecord(sessionId: string, record: SessionActivityRecord): boolean {
		const records = this.#options.getActivityRecords();
		const current = records.get(sessionId);
		if (current?.activeUntil === record.activeUntil && current.seenThroughAt === record.seenThroughAt) return false;
		const nextRecords = new Map(records);
		nextRecords.set(sessionId, record);
		this.#options.setActivityRecords(nextRecords);
		return true;
	}

	#rebuildActivityOrder(sessions = this.#options.getSessions()) {
		this.#options.setActivityOrder(buildActivityOrder(
			sessions,
			this.#options.getActivityOrder(),
			this.#options.getActivityRecords()
		));
	}

	#removeSessionActivity(sessionId: string) {
		const activityOrder = this.#options.getActivityOrder();
		if (activityOrder.includes(sessionId)) {
			this.#options.setActivityOrder(activityOrder.filter((id) => id !== sessionId));
		}
	}

	#removeRecord(sessionId: string) {
		const records = this.#options.getActivityRecords();
		if (!records.has(sessionId)) return;
		const nextRecords = new Map(records);
		nextRecords.delete(sessionId);
		this.#options.setActivityRecords(nextRecords);
	}

	#pruneSessions(sessions = this.#options.getSessions()) {
		const sessionIds = new Set(sessions.map((session) => session.id));
		for (const sessionId of this.#activeExpiryTimers.keys()) {
			if (!sessionIds.has(sessionId)) this.removeSession(sessionId);
		}
		for (const sessionId of this.#outputActivityTimers.keys()) {
			if (!sessionIds.has(sessionId)) this.removeSession(sessionId);
		}
		const records = this.#options.getActivityRecords();
		const nextRecords = new Map([...records].filter(([id]) => sessionIds.has(id)));
		if (nextRecords.size !== records.size) {
			this.#options.setActivityRecords(nextRecords);
			this.#persistSeenOutput();
		}
	}

	#persistSeenOutput() {
		if (!this.#storage) return;
		const sessions = Object.fromEntries(
			[...this.#options.getActivityRecords()]
				.filter(([, record]) => record.seenThroughAt > 0)
				.map(([sessionId, record]) => [sessionId, record.seenThroughAt])
		);
		try {
			this.#storage.setItem(SESSION_OUTPUT_SEEN_KEY, JSON.stringify({
				version: SESSION_OUTPUT_SEEN_VERSION,
				sessions
			} satisfies SessionOutputSeenState));
		} catch {
			// Storage can be unavailable or full; activity remains correct for this page lifetime.
		}
	}

	#clearTimers(sessionId: string) {
		const outputTimer = this.#outputActivityTimers.get(sessionId);
		if (outputTimer !== undefined) this.#scheduler.clearTimeout(outputTimer);
		this.#outputActivityTimers.delete(sessionId);
		const activeTimer = this.#activeExpiryTimers.get(sessionId);
		if (activeTimer !== undefined) this.#scheduler.clearTimeout(activeTimer);
		this.#activeExpiryTimers.delete(sessionId);
	}

	#clearAllTimers() {
		for (const timer of this.#outputActivityTimers.values()) this.#scheduler.clearTimeout(timer);
		this.#outputActivityTimers.clear();
		for (const timer of this.#activeExpiryTimers.values()) this.#scheduler.clearTimeout(timer);
		this.#activeExpiryTimers.clear();
		this.#pendingOutputActivity.clear();
		this.#lastOutputActivityUpdate.clear();
	}
}
