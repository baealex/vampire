import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '..');
const compilerOptions = {
	module: ts.ModuleKind.ESNext,
	target: ts.ScriptTarget.ES2022
};

const viewSource = await readFile(resolve(root, 'src/lib/session/view.ts'), 'utf8');
const viewCompiled = ts.transpileModule(viewSource, { compilerOptions }).outputText;
const viewUrl = `data:text/javascript;base64,${Buffer.from(viewCompiled).toString('base64')}`;
const view = await import(viewUrl);
const controllerSource = (await readFile(resolve(root, 'src/lib/session/activity-controller.ts'), 'utf8'))
	.replace("from './view'", `from '${viewUrl}'`);
const controllerCompiled = ts.transpileModule(controllerSource, { compilerOptions }).outputText;
const { SessionActivityController } = await import(
	`data:text/javascript;base64,${Buffer.from(controllerCompiled).toString('base64')}`
);

let now = 1_000_000;
let nextTimerId = 0;
const timers = new Map();
globalThis.window = {
	setTimeout(callback, delay) {
		const id = ++nextTimerId;
		timers.set(id, { at: now + Math.max(0, delay), callback });
		return id;
	},
	clearTimeout(id) {
		timers.delete(id);
	}
};
const originalDateNow = Date.now;
Date.now = () => now;

function advance(milliseconds) {
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

function session(lastOutputAt = null, id = 'workspace-1') {
	return {
		id,
		cwd: '/tmp/workspace-1',
		createdAt: 1,
		lastActiveAt: 1,
		lastOutputAt,
		notePreview: '',
		state: 'running',
		attachedClients: 0,
		foregroundProcess: null
	};
}

function createStorage() {
	const values = new Map();
	return {
		getItem(key) { return values.get(key) ?? null; },
		setItem(key, value) { values.set(key, value); },
		removeItem(key) { values.delete(key); }
	};
}

function createHarness({ initialLastOutputAt = null, storage } = {}) {
	const initialSession = session(initialLastOutputAt);
	let sessions = [initialSession];
	let observed = false;
	let activityRecords = new Map();
	let activityOrder = [];
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
	});
	if (storage) controller.restoreBrowserPreferences(storage);
	controller.applySessions([], sessions, false);
	return {
		controller,
		get sessions() { return sessions; },
		get activityRecords() { return activityRecords; },
		state(sessionId = 'workspace-1') {
			return view.sessionActivityState(
				sessions.find((item) => item.id === sessionId),
				activityRecords,
				now
			);
		},
		setObserved(value) { observed = value; },
		setSessions(nextSessions) { sessions = nextSessions; }
	};
}

test.afterEach(() => {
	timers.clear();
});

test.after(() => {
	Date.now = originalDateNow;
	delete globalThis.window;
});

test('transitions unobserved output from active to review to idle', () => {
	now = 1_000_000;
	const harness = createHarness();
	harness.controller.recordSessionOutput('workspace-1', true, now, false);
	assert.equal(harness.state(), 'active');
	assert.equal(harness.activityRecords.get('workspace-1').seenThroughAt, 0);

	advance(7_999);
	assert.equal(harness.state(), 'active');
	advance(1);
	assert.equal(harness.state(), 'review');

	harness.controller.markSessionObserved('workspace-1');
	assert.equal(harness.state(), 'idle');
	assert.equal(harness.activityRecords.get('workspace-1').seenThroughAt, harness.sessions[0].lastOutputAt);
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
	assert.equal(harness.activityRecords.get('workspace-1').seenThroughAt, now);

	harness.controller.recordSessionOutput('workspace-1', true, now, true);
	assert.equal(harness.state(), 'active');
	advance(8_000);
	assert.equal(harness.state(), 'idle');
});

test('persists the output watermark across page lifetimes', () => {
	now = 1_000_000;
	const storage = createStorage();
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
