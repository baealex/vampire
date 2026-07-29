import assert from 'node:assert/strict';
import test from 'node:test';
import { TerminalScreenSync } from '../src/lib/terminal/screen-sync.mjs';

class FakeScheduler {
	now = 0;
	nextId = 0;
	timers = new Map();
	frames = new Map();

	setTimeout = (callback, delay) => {
		const id = ++this.nextId;
		this.timers.set(id, { at: this.now + delay, callback });
		return id;
	};

	clearTimeout = (id) => this.timers.delete(id);

	requestFrame = (callback) => {
		const id = ++this.nextId;
		this.frames.set(id, callback);
		return id;
	};

	cancelFrame = (id) => this.frames.delete(id);

	flushFrame() {
		const callbacks = [...this.frames.values()];
		this.frames.clear();
		for (const callback of callbacks) callback();
	}

	advance(milliseconds) {
		this.now += milliseconds;
		while (true) {
			const due = [...this.timers.entries()]
				.filter(([, timer]) => timer.at <= this.now)
				.sort(([, left], [, right]) => left.at - right.at)[0];
			if (!due) return;
			this.timers.delete(due[0]);
			due[1].callback();
		}
	}
}

function createHarness() {
	const scheduler = new FakeScheduler();
	const writes = [];
	const readyStates = [];
	let resets = 0;
	let refreshes = 0;
	let completedWrites = 0;
	const sync = new TerminalScreenSync({
		reset: () => { resets += 1; },
		write: (data, complete) => writes.push({ data, complete }),
		refresh: () => { refreshes += 1; },
		onReadyChange: (ready) => readyStates.push(ready),
		onWriteComplete: () => { completedWrites += 1; }
	}, {
		setTimeout: scheduler.setTimeout,
		clearTimeout: scheduler.clearTimeout,
		requestFrame: scheduler.requestFrame,
		cancelFrame: scheduler.cancelFrame
	});
	return {
		sync,
		scheduler,
		writes,
		readyStates,
		get resets() { return resets; },
		get refreshes() { return refreshes; },
		get completedWrites() { return completedWrites; }
	};
}

test('restores the snapshot before buffered output and reveals only after writes settle', () => {
	const harness = createHarness();
	let acknowledgements = 0;
	harness.sync.beginSnapshot('snapshot', {
		isCurrent: () => true,
		acknowledge: () => { acknowledgements += 1; return true; }
	});
	harness.sync.pushOutput('later output');
	harness.sync.markScreenReady();
	assert.equal(harness.resets, 1);
	assert.deepEqual(harness.writes.map(({ data }) => data), ['snapshot']);
	assert.deepEqual(harness.readyStates, [false]);

	harness.writes[0].complete();
	assert.deepEqual(harness.writes.map(({ data }) => data), ['snapshot', 'later output']);
	assert.deepEqual(harness.readyStates, [false]);
	harness.writes[1].complete();
	assert.equal(harness.completedWrites, 1);

	harness.scheduler.flushFrame();
	harness.scheduler.flushFrame();
	assert.equal(acknowledgements, 1);
	assert.deepEqual(harness.readyStates, [false, true]);
	assert.ok(harness.refreshes >= 2);
});

test('ignores completion work from a snapshot replaced by a newer connection', () => {
	const harness = createHarness();
	let firstAcknowledgements = 0;
	let secondAcknowledgements = 0;
	harness.sync.beginSnapshot('first', {
		isCurrent: () => true,
		acknowledge: () => { firstAcknowledgements += 1; return true; }
	});
	harness.sync.pushOutput('discarded');
	harness.sync.beginSnapshot('second', {
		isCurrent: () => true,
		acknowledge: () => { secondAcknowledgements += 1; return true; }
	});

	harness.writes[0].complete();
	harness.writes[1].complete();
	harness.scheduler.flushFrame();
	harness.scheduler.flushFrame();
	assert.deepEqual(harness.writes.map(({ data }) => data), ['first', 'second']);
	assert.equal(firstAcknowledgements, 0);
	assert.equal(secondAcknowledgements, 1);
});

test('does not let output completion from an old snapshot settle a newer snapshot', () => {
	const harness = createHarness();
	harness.sync.beginSnapshot('first', { isCurrent: () => true, acknowledge: () => true });
	harness.writes[0].complete();
	harness.sync.pushOutput('old output');
	harness.sync.beginSnapshot('second', { isCurrent: () => true, acknowledge: () => true });
	harness.writes[2].complete();
	harness.sync.pushOutput('new output');
	harness.sync.markScreenReady();

	harness.writes[1].complete();
	harness.scheduler.flushFrame();
	harness.scheduler.flushFrame();
	assert.deepEqual(harness.readyStates, [false, false]);

	harness.writes[3].complete();
	harness.scheduler.flushFrame();
	harness.scheduler.flushFrame();
	assert.deepEqual(harness.readyStates, [false, false, true]);
});

test('uses the reveal deadline when the server ready signal is delayed', () => {
	const harness = createHarness();
	harness.sync.beginSnapshot('snapshot', {
		isCurrent: () => true,
		acknowledge: () => true
	});
	harness.writes[0].complete();
	harness.scheduler.flushFrame();
	harness.scheduler.flushFrame();
	assert.deepEqual(harness.readyStates, [false]);
	harness.scheduler.advance(1_499);
	assert.deepEqual(harness.readyStates, [false]);
	harness.scheduler.advance(1);
	harness.scheduler.flushFrame();
	harness.scheduler.flushFrame();
	assert.deepEqual(harness.readyStates, [false, true]);
});
