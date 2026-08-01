import assert from 'node:assert/strict';
import test from 'node:test';
import {
	SessionActivityController,
	type SessionActivityScheduler
} from '../src/lib/session/activity-controller.ts';
import * as view from '../src/lib/session/view.ts';
import type { ManagedSession, SessionTerminal } from '../src/lib/session/types.ts';
import type { SessionActivityRecord } from '../src/lib/session/view.ts';

let now = 1_000_000;
let nextTimerId = 0;
const timers = new Map<number, { at: number; callback: () => void }>();
const scheduler: SessionActivityScheduler = {
	now: () => now,
	setTimeout(callback, delay) {
		const id = ++nextTimerId;
		timers.set(id, { at: now + Math.max(0, delay), callback });
		return id;
	},
	clearTimeout(id) {
		timers.delete(id);
	}
};

function advance(milliseconds: number): void {
	now += milliseconds;
	while (true) {
		const due = [...timers.entries()]
			.filter(([, timer]) => timer.at <= now)
			.sort(([, left], [, right]) => left.at - right.at)[0];
		if (!due) return;
		timers.delete(due[0]);
		due[1].callback();
	}
}

function session(lastOutputAt: number | null = null, id = 'workspace-1'): ManagedSession {
	return {
		id,
		tmuxSession: `vampire-${id}`,
		cwd: '/tmp/workspace-1',
		createdAt: 1,
		lastActiveAt: 1,
		lastOutputAt,
		notePreview: '',
		favoriteCommands: [],
		state: 'running',
		attachedClients: 0,
		foregroundProcess: null,
		terminals: [],
		agentState: null,
		isGitRepository: false
	};
}

function terminal(id: string, index: number, lastOutputAt: number): SessionTerminal {
	return {
		id,
		index,
		name: index === 0 ? 'main' : 'server',
		active: index === 0,
		lastOutputAt,
		foregroundProcess: null,
		command: null,
		startedAt: null,
		state: 'running',
		exitCode: null
	};
}

class MemoryStorage implements Storage {
	readonly #values = new Map<string, string>();
	get length(): number { return this.#values.size; }
	clear(): void { this.#values.clear(); }
	getItem(key: string): string | null { return this.#values.get(key) ?? null; }
	key(index: number): string | null { return [...this.#values.keys()][index] ?? null; }
	removeItem(key: string): void { this.#values.delete(key); }
	setItem(key: string, value: string): void { this.#values.set(key, value); }
}

interface HarnessOptions {
	initialLastOutputAt?: number | null;
	storage?: Storage;
}

function createHarness({ initialLastOutputAt = null, storage }: HarnessOptions = {}) {
	const initialSession = session(initialLastOutputAt);
	let sessions: ManagedSession[] = [initialSession];
	let observed = false;
	let activityRecords = new Map<string, SessionActivityRecord>();
	let activityOrder: string[] = [];
	const controller = new SessionActivityController({
		isSessionObserved: () => observed,
		getSessions: () => sessions,
		getActivityRecords: () => activityRecords,
		setActivityRecords: (records) => { activityRecords = records; },
		getActivityOrder: () => activityOrder,
		setActivityOrder: (order) => { activityOrder = order; },
		updateSessionOutput: (sessionId, timestamp) => {
			sessions = sessions.map((item) => item.id === sessionId
				? { ...item, lastOutputAt: Math.max(item.lastOutputAt ?? 0, timestamp) }
				: item);
		}
	}, scheduler);
	if (storage) controller.restoreBrowserPreferences(storage);
	controller.applySessions([], sessions, false);
	return {
		controller,
		get sessions() { return sessions; },
		get activityRecords() { return activityRecords; },
		get activityOrder() { return activityOrder; },
		state(sessionId = 'workspace-1') {
			return view.sessionActivityState(
				sessions.find((item) => item.id === sessionId)!,
				activityRecords,
				now
			);
		},
		setObserved(value: boolean) { observed = value; },
		setSessions(nextSessions: ManagedSession[]) { sessions = nextSessions; }
	};
}

test.afterEach(() => {
	timers.clear();
});

test('transitions unobserved output from active to review to idle', () => {
	now = 1_000_000;
	const harness = createHarness();
	harness.controller.recordSessionOutput('workspace-1', true, now, false);
	assert.equal(harness.state(), 'active');
	assert.equal(harness.activityRecords.get('workspace-1')!.seenThroughAt, 0);

	advance(7_999);
	assert.equal(harness.state(), 'active');
	advance(1);
	assert.equal(harness.state(), 'review');
	assert.equal(harness.activityRecords.get('workspace-1')!.activeUntil, 0);

	harness.controller.markSessionObserved('workspace-1');
	assert.equal(harness.state(), 'idle');
	assert.equal(harness.activityRecords.get('workspace-1')!.seenThroughAt, now);
});

test('extends active while output continues and re-enters active from review', () => {
	now = 1_000_000;
	const harness = createHarness();
	harness.controller.recordSessionOutput('workspace-1', true, now, false);
	advance(6_000);
	harness.controller.recordSessionOutput('workspace-1', true, now, false);
	advance(7_999);
	assert.equal(harness.state(), 'active');
	advance(1);
	assert.equal(harness.state(), 'review');
	harness.controller.recordSessionOutput('workspace-1', true, now, false);
	assert.equal(harness.state(), 'active');
});

test('gives recognized terminal agents a longer fallback for silent tool work', () => {
	now = 1_000_000;
	const harness = createHarness();
	harness.setSessions([{
		...harness.sessions[0],
		foregroundProcess: { kind: 'command', label: 'codex' }
	}]);
	harness.controller.recordSessionOutput('workspace-1', true, now, false);

	advance(29_999);
	assert.equal(harness.state(), 'active');
	advance(1);
	assert.equal(harness.state(), 'review');
});

test('uses the same stable quiet deadline for background and direct terminal output', () => {
	now = 1_000_000;
	const harness = createHarness();
	const previous = harness.sessions[0];
	const next = session(now);
	harness.setSessions([next]);
	harness.controller.applySessions([previous], [next], true);
	assert.equal(harness.state(), 'active');

	advance(7_999);
	assert.equal(harness.state(), 'active');
	advance(1);
	assert.equal(harness.state(), 'review');
});

test('ignores background process polling output until the main session changes', () => {
	now = 1_000_000;
	const harness = createHarness({ initialLastOutputAt: 1_000 });
	const previous = {
		...harness.sessions[0],
		terminals: [
			terminal('@0', 0, 1_000),
			terminal('@1', 1, 1_000)
		]
	};
	const auxiliaryOutput = {
		...previous,
		lastOutputAt: 2_000,
		terminals: [previous.terminals[0], { ...previous.terminals[1], lastOutputAt: 2_000 }]
	};
	harness.setSessions([auxiliaryOutput]);
	harness.controller.applySessions([previous], [auxiliaryOutput], true);
	assert.equal(harness.state(), 'idle');

	const mainOutput = {
		...auxiliaryOutput,
		lastOutputAt: 3_000,
		terminals: [{ ...auxiliaryOutput.terminals[0], lastOutputAt: 3_000 }, auxiliaryOutput.terminals[1]]
	};
	harness.setSessions([mainOutput]);
	harness.controller.applySessions([auxiliaryOutput], [mainOutput], true);
	assert.equal(harness.state(), 'active');
});

test('renews background activity before its previous quiet deadline', () => {
	now = 1_000_000;
	const harness = createHarness();
	let previous = harness.sessions[0];
	let next = session(now);
	harness.setSessions([next]);
	harness.controller.applySessions([previous], [next], true);

	advance(6_000);
	previous = next;
	next = session(now);
	harness.setSessions([next]);
	harness.controller.applySessions([previous], [next], true);
	advance(7_999);
	assert.equal(harness.state(), 'active');
	advance(1);
	assert.equal(harness.state(), 'review');
});

test('treats observed polling updates as seen but honors direct terminal activity', () => {
	now = 1_000_000;
	const harness = createHarness();
	harness.setObserved(true);
	const previous = harness.sessions[0];
	const next = session(now);
	harness.setSessions([next]);
	harness.controller.applySessions([previous], [next], true);
	assert.equal(harness.state(), 'idle');
	assert.equal(harness.activityRecords.get('workspace-1')!.seenThroughAt, now);

	harness.controller.recordSessionOutput('workspace-1', true, now, true);
	assert.equal(harness.state(), 'active');
	advance(8_000);
	assert.equal(harness.state(), 'idle');
});

test('persists the output watermark across page lifetimes', () => {
	now = 1_000_000;
	const storage = new MemoryStorage();
	const firstPage = createHarness({ initialLastOutputAt: 1_000, storage });
	assert.equal(firstPage.state(), 'idle');

	firstPage.controller.recordSessionOutput('workspace-1', true, 2_000, false);
	advance(8_000);
	assert.equal(firstPage.state(), 'review');

	const reloadedPage = createHarness({ initialLastOutputAt: 2_000, storage });
	assert.equal(reloadedPage.state(), 'review');
	reloadedPage.controller.markSessionObserved('workspace-1');
	assert.equal(reloadedPage.state(), 'idle');

	const seenReload = createHarness({ initialLastOutputAt: 2_000, storage });
	assert.equal(seenReload.state(), 'idle');
});
