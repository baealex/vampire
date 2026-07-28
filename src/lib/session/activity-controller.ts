import {
	buildActivityOrder,
	SESSION_ACTIVITY_WINDOW_MS,
	sessionActivityState,
	sessionOutputBecameUnread
} from './view';
import type { ManagedSession } from './types';

const OUTPUT_ACTIVITY_UPDATE_INTERVAL_MS = 500;
const OUTPUT_ACTIVITY_SETTLE_MS = 2_500;

type SessionActivityControllerOptions = {
	isSessionObserved: (sessionId: string) => boolean;
	getSessions: () => ManagedSession[];
	getActiveOutputSessionId: () => string | undefined;
	setActiveOutputSessionId: (sessionId: string | undefined) => void;
	getUnreadSessionIds: () => Set<string>;
	setUnreadSessionIds: (sessionIds: Set<string>) => void;
	getActivityOrder: () => string[];
	setActivityOrder: (order: string[]) => void;
	updateSessionOutput: (sessionId: string, timestamp: number) => void;
};

export class SessionActivityController {
	#lastOutputActivityUpdate = new Map<string, number>();
	#observedOutputThrough = new Map<string, number>();
	#outputActivityTimers = new Map<string, number>();
	#activeOutputTimers = new Map<string, number>();
	#reviewTimers = new Map<string, number>();
	#pendingOutputActivity = new Map<string, number>();
	#observedActiveSessionIds = new Set<string>();

	constructor(private readonly options: SessionActivityControllerOptions) {}

	applySessions(previousSessions: ManagedSession[], nextSessions: ManagedSession[], sessionsLoaded: boolean) {
		if (sessionsLoaded) {
			const previousById = new Map(previousSessions.map((session) => [session.id, session]));
			for (const session of nextSessions) {
				const previousOutputAt = previousById.get(session.id)?.lastOutputAt ?? null;
				if (sessionOutputBecameUnread(
					previousOutputAt,
					session.lastOutputAt,
					this.#observedOutputThrough.get(session.id) ?? 0,
					this.options.isSessionObserved(session.id)
				)) {
					this.#markSessionUnread(session.id, session.lastOutputAt ?? undefined);
				}
			}
		}
		this.#pruneUnreadSessions(nextSessions);
		this.#rebuildActivityOrder(nextSessions);
	}

	applySessionUpdated(
		previous: ManagedSession,
		next: ManagedSession,
		nextSessions: ManagedSession[],
		sessionsLoaded: boolean
	) {
		const outputBecameUnread = sessionsLoaded && sessionOutputBecameUnread(
			previous.lastOutputAt,
			next.lastOutputAt,
			this.#observedOutputThrough.get(next.id) ?? 0,
			this.options.isSessionObserved(next.id)
		);
		if (outputBecameUnread) this.#markSessionUnread(next.id, next.lastOutputAt ?? undefined);
		if (outputBecameUnread || previous.state !== next.state) this.#rebuildActivityOrder(nextSessions);
	}

	recordSessionOutput(sessionId: string, active: boolean, timestamp?: number, observed = false) {
		if (active) {
			const outputTimestamp = timestamp ?? Date.now();
			this.options.setActiveOutputSessionId(sessionId);
			if (observed) this.markSessionObserved(sessionId, outputTimestamp);
			else {
				this.#markSessionUnread(sessionId, outputTimestamp);
				this.#rebuildActivityOrder();
			}
			this.#scheduleActiveOutputExpiry(sessionId, OUTPUT_ACTIVITY_SETTLE_MS);
			this.#recordOutputActivity(sessionId, outputTimestamp);
		} else if (this.options.getActiveOutputSessionId() === sessionId) {
			this.#flushOutputActivity(sessionId);
		}
	}

	markSessionObserved(sessionId: string, timestamp = Date.now()) {
		const observedThrough = Math.max(timestamp, this.#observedOutputThrough.get(sessionId) ?? 0);
		this.#observedOutputThrough.set(sessionId, observedThrough);

		const session = this.options.getSessions().find((item) => item.id === sessionId);
		const unreadSessionIds = this.options.getUnreadSessionIds();
		const hasUnreadOutput = unreadSessionIds.has(sessionId);
		const activeOutputSessionId = this.options.getActiveOutputSessionId();
		const activityState = session
			? sessionActivityState(session, activeOutputSessionId, hasUnreadOutput)
			: undefined;
		if (activityState === 'live') {
			this.#observedActiveSessionIds.add(sessionId);
			const settleDelay = activeOutputSessionId === sessionId
				? OUTPUT_ACTIVITY_SETTLE_MS
				: Math.max(0, observedThrough + SESSION_ACTIVITY_WINDOW_MS - Date.now());
			this.#scheduleActiveOutputExpiry(sessionId, settleDelay);
			return;
		}
		if (hasUnreadOutput) this.#markSessionRead(sessionId);
		this.#rebuildActivityOrder();
	}

	removeSession(sessionId: string) {
		this.clearOutputActivity(sessionId);
		this.markSessionObserved(sessionId);
		this.#observedOutputThrough.delete(sessionId);
		this.#pruneUnreadSessions();
		this.#removeSessionActivity(sessionId);
	}

	rebuild(sessions = this.options.getSessions()) {
		this.#rebuildActivityOrder(sessions);
	}

	clearOutputActivity(sessionId: string) {
		const timer = this.#outputActivityTimers.get(sessionId);
		if (timer !== undefined) window.clearTimeout(timer);
		this.#outputActivityTimers.delete(sessionId);
		const activeTimer = this.#activeOutputTimers.get(sessionId);
		if (activeTimer !== undefined) window.clearTimeout(activeTimer);
		this.#activeOutputTimers.delete(sessionId);
		this.#observedActiveSessionIds.delete(sessionId);
		if (this.options.getActiveOutputSessionId() === sessionId) this.options.setActiveOutputSessionId(undefined);
		this.#pendingOutputActivity.delete(sessionId);
		this.#lastOutputActivityUpdate.delete(sessionId);
	}

	reset() {
		this.#clearAllOutputActivity();
		this.#clearAllReviewTimers();
		this.#observedOutputThrough.clear();
		this.options.setActivityOrder([]);
		this.options.setActiveOutputSessionId(undefined);
		this.options.setUnreadSessionIds(new Set());
	}

	dispose() {
		this.#clearAllOutputActivity();
		this.#clearAllReviewTimers();
		this.options.setActivityOrder([]);
	}

	#recordOutputActivity(sessionId: string, timestamp: number) {
		const now = Date.now();
		const elapsed = now - (this.#lastOutputActivityUpdate.get(sessionId) ?? -Infinity);
		if (elapsed >= OUTPUT_ACTIVITY_UPDATE_INTERVAL_MS) {
			const scheduledTimer = this.#outputActivityTimers.get(sessionId);
			if (scheduledTimer !== undefined) window.clearTimeout(scheduledTimer);
			this.#outputActivityTimers.delete(sessionId);
			this.#commitOutputActivity(sessionId, timestamp, now);
			return;
		}

		this.#pendingOutputActivity.set(sessionId, timestamp);
		if (this.#outputActivityTimers.has(sessionId)) return;
		this.#outputActivityTimers.set(sessionId, window.setTimeout(() => {
			this.#outputActivityTimers.delete(sessionId);
			const pendingTimestamp = this.#pendingOutputActivity.get(sessionId);
			if (pendingTimestamp !== undefined) this.#commitOutputActivity(sessionId, pendingTimestamp, Date.now());
		}, OUTPUT_ACTIVITY_UPDATE_INTERVAL_MS - elapsed));
	}

	#flushOutputActivity(sessionId: string) {
		const timer = this.#outputActivityTimers.get(sessionId);
		if (timer !== undefined) window.clearTimeout(timer);
		this.#outputActivityTimers.delete(sessionId);
		const pendingTimestamp = this.#pendingOutputActivity.get(sessionId);
		if (pendingTimestamp !== undefined) this.#commitOutputActivity(sessionId, pendingTimestamp, Date.now());
	}

	#commitOutputActivity(sessionId: string, timestamp: number, recordedAt: number) {
		this.#pendingOutputActivity.delete(sessionId);
		this.#lastOutputActivityUpdate.set(sessionId, recordedAt);
		this.options.updateSessionOutput(sessionId, timestamp);
	}

	#markSessionUnread(sessionId: string, outputAt?: number) {
		this.#observedActiveSessionIds.delete(sessionId);
		const unreadSessionIds = this.options.getUnreadSessionIds();
		if (!unreadSessionIds.has(sessionId)) {
			this.options.setUnreadSessionIds(new Set(unreadSessionIds).add(sessionId));
		}
		if (outputAt !== undefined) this.#scheduleReviewTransition(sessionId, outputAt);
	}

	#markSessionRead(sessionId: string) {
		this.#clearReviewTimer(sessionId);
		this.#observedActiveSessionIds.delete(sessionId);
		const unreadSessionIds = this.options.getUnreadSessionIds();
		if (!unreadSessionIds.has(sessionId)) return;
		const nextUnreadSessionIds = new Set(unreadSessionIds);
		nextUnreadSessionIds.delete(sessionId);
		this.options.setUnreadSessionIds(nextUnreadSessionIds);
	}

	#scheduleReviewTransition(sessionId: string, outputAt: number) {
		this.#clearReviewTimer(sessionId);
		const delay = Math.max(0, outputAt + SESSION_ACTIVITY_WINDOW_MS - Date.now());
		this.#reviewTimers.set(sessionId, window.setTimeout(() => {
			this.#reviewTimers.delete(sessionId);
			if (!this.options.getUnreadSessionIds().has(sessionId)) return;

			const latestOutputAt = this.options.getSessions().find((session) => session.id === sessionId)?.lastOutputAt ?? outputAt;
			if (Date.now() - latestOutputAt < SESSION_ACTIVITY_WINDOW_MS) {
				this.#scheduleReviewTransition(sessionId, latestOutputAt);
				return;
			}
			this.#rebuildActivityOrder();
		}, delay));
	}

	#clearReviewTimer(sessionId: string) {
		const timer = this.#reviewTimers.get(sessionId);
		if (timer !== undefined) window.clearTimeout(timer);
		this.#reviewTimers.delete(sessionId);
	}

	#scheduleActiveOutputExpiry(sessionId: string, delay: number) {
		const existingTimer = this.#activeOutputTimers.get(sessionId);
		if (existingTimer !== undefined) window.clearTimeout(existingTimer);
		this.#activeOutputTimers.set(sessionId, window.setTimeout(() => {
			this.#activeOutputTimers.delete(sessionId);
			if (this.options.getActiveOutputSessionId() === sessionId) this.options.setActiveOutputSessionId(undefined);
			if (this.#observedActiveSessionIds.delete(sessionId)) this.#markSessionRead(sessionId);
			this.#rebuildActivityOrder();
		}, delay));
	}

	#rebuildActivityOrder(sessions = this.options.getSessions()) {
		this.options.setActivityOrder(buildActivityOrder(
			sessions,
			this.options.getActivityOrder(),
			this.options.getActiveOutputSessionId(),
			this.options.getUnreadSessionIds()
		));
	}

	#removeSessionActivity(sessionId: string) {
		const activityOrder = this.options.getActivityOrder();
		if (activityOrder.includes(sessionId)) {
			this.options.setActivityOrder(activityOrder.filter((id) => id !== sessionId));
		}
	}

	#pruneUnreadSessions(sessions = this.options.getSessions()) {
		const sessionIds = new Set(sessions.map((session) => session.id));
		const unreadSessionIds = this.options.getUnreadSessionIds();
		const nextUnreadSessionIds = new Set([...unreadSessionIds].filter((id) => sessionIds.has(id)));
		if (nextUnreadSessionIds.size !== unreadSessionIds.size) this.options.setUnreadSessionIds(nextUnreadSessionIds);
		for (const sessionId of this.#reviewTimers.keys()) {
			if (!nextUnreadSessionIds.has(sessionId)) this.#clearReviewTimer(sessionId);
		}
		for (const sessionId of this.#observedOutputThrough.keys()) {
			if (!sessionIds.has(sessionId)) this.#observedOutputThrough.delete(sessionId);
		}
	}

	#clearAllOutputActivity() {
		for (const timer of this.#outputActivityTimers.values()) window.clearTimeout(timer);
		this.#outputActivityTimers.clear();
		for (const timer of this.#activeOutputTimers.values()) window.clearTimeout(timer);
		this.#activeOutputTimers.clear();
		this.#observedActiveSessionIds.clear();
		this.options.setActiveOutputSessionId(undefined);
		this.#pendingOutputActivity.clear();
		this.#lastOutputActivityUpdate.clear();
	}

	#clearAllReviewTimers() {
		for (const timer of this.#reviewTimers.values()) window.clearTimeout(timer);
		this.#reviewTimers.clear();
	}
}
