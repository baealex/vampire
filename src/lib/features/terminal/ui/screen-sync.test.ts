import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TERMINAL_OUTPUT_BACKLOG_CHARACTER_LIMIT,
  TERMINAL_OUTPUT_BATCH_CHARACTER_LIMIT,
  TerminalScreenSync,
} from '~/lib/features/terminal/ui/screen-sync.ts';

class FakeScheduler {
  now = 0;
  nextId = 0;
  timers = new Map<number, { at: number; callback: () => void }>();
  frames = new Map<number, () => void>();

  setTimeout = (callback: () => void, delay: number): number => {
    const id = ++this.nextId;
    this.timers.set(id, { at: this.now + delay, callback });
    return id;
  };

  clearTimeout = (id: unknown): boolean => this.timers.delete(id as number);

  requestFrame = (callback: () => void): number => {
    const id = ++this.nextId;
    this.frames.set(id, callback);
    return id;
  };

  cancelFrame = (id: number): boolean => this.frames.delete(id);

  flushFrame(): void {
    const callbacks = [...this.frames.values()];
    this.frames.clear();
    for (const callback of callbacks) callback();
  }

  advance(milliseconds: number): void {
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
  const writes: Array<{ data: string; complete: () => void }> = [];
  const readyStates: boolean[] = [];
  let resets = 0;
  let refreshes = 0;
  let completedWrites = 0;
  let replacedScreens = 0;
  let overflows = 0;
  const sync = new TerminalScreenSync(
    {
      reset: () => {
        resets += 1;
      },
      write: (data, complete) => writes.push({ data, complete }),
      resetAndWrite: (data, complete) => writes.push({ data: `\u001bc${data}`, complete }),
      refresh: () => {
        refreshes += 1;
      },
      onReadyChange: (ready) => readyStates.push(ready),
      onWriteComplete: () => {
        completedWrites += 1;
      },
      onScreenReplaced: () => {
        replacedScreens += 1;
      },
      onOverflow: () => {
        overflows += 1;
      },
    },
    {
      setTimeout: scheduler.setTimeout,
      clearTimeout: scheduler.clearTimeout,
      requestFrame: scheduler.requestFrame,
      cancelFrame: scheduler.cancelFrame,
    }
  );
  return {
    sync,
    scheduler,
    writes,
    readyStates,
    get resets() {
      return resets;
    },
    get refreshes() {
      return refreshes;
    },
    get completedWrites() {
      return completedWrites;
    },
    get replacedScreens() {
      return replacedScreens;
    },
    get overflows() {
      return overflows;
    },
  };
}

test('restores the snapshot before buffered output and reveals only after writes settle', () => {
  const harness = createHarness();
  let acknowledgements = 0;
  harness.sync.beginSnapshot('snapshot', {
    isCurrent: () => true,
    acknowledge: () => {
      acknowledgements += 1;
      return true;
    },
  });
  harness.sync.pushOutput('later output');
  harness.sync.markScreenReady();
  assert.equal(harness.resets, 1);
  assert.deepEqual(
    harness.writes.map(({ data }) => data),
    ['snapshot']
  );
  assert.deepEqual(harness.readyStates, [false]);

  harness.writes[0].complete();
  harness.scheduler.flushFrame();
  assert.deepEqual(
    harness.writes.map(({ data }) => data),
    ['snapshot', 'later output']
  );
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
    acknowledge: () => {
      firstAcknowledgements += 1;
      return true;
    },
  });
  harness.sync.pushOutput('discarded');
  harness.sync.beginSnapshot('second', {
    isCurrent: () => true,
    acknowledge: () => {
      secondAcknowledgements += 1;
      return true;
    },
  });

  assert.deepEqual(
    harness.writes.map(({ data }) => data),
    ['first']
  );
  harness.writes[0].complete();
  assert.deepEqual(
    harness.writes.map(({ data }) => data),
    ['first', 'second']
  );
  harness.writes[1].complete();
  harness.scheduler.flushFrame();
  harness.scheduler.flushFrame();
  assert.deepEqual(
    harness.writes.map(({ data }) => data),
    ['first', 'second']
  );
  assert.equal(firstAcknowledgements, 0);
  assert.equal(secondAcknowledgements, 1);
});

test('does not let output completion from an old snapshot settle a newer snapshot', () => {
  const harness = createHarness();
  harness.sync.beginSnapshot('first', { isCurrent: () => true, acknowledge: () => true });
  harness.writes[0].complete();
  harness.sync.pushOutput('old output');
  harness.scheduler.flushFrame();
  harness.sync.beginSnapshot('second', { isCurrent: () => true, acknowledge: () => true });
  assert.deepEqual(
    harness.writes.map(({ data }) => data),
    ['first', 'old output']
  );
  harness.writes[1].complete();
  assert.deepEqual(
    harness.writes.map(({ data }) => data),
    ['first', 'old output', 'second']
  );
  harness.writes[2].complete();
  harness.sync.pushOutput('new output');
  harness.sync.markScreenReady();

  harness.scheduler.flushFrame();
  harness.writes[3].complete();
  harness.scheduler.flushFrame();
  harness.scheduler.flushFrame();
  harness.scheduler.flushFrame();
  assert.deepEqual(harness.readyStates, [false, false, true]);
});

test('writes output immediately and serializes anything received during the active xterm write', () => {
  const harness = createHarness();
  harness.sync.beginSnapshot('snapshot', { isCurrent: () => true, acknowledge: () => true });
  harness.writes[0].complete();
  harness.sync.pushOutput('first');
  harness.sync.pushOutput(' second');
  assert.deepEqual(
    harness.writes.map(({ data }) => data),
    ['snapshot', 'first']
  );

  harness.sync.pushOutput(' third');
  assert.equal(harness.writes.length, 2);
  harness.writes[1].complete();
  assert.deepEqual(
    harness.writes.map(({ data }) => data),
    ['snapshot', 'first', ' second third']
  );
});

test('applies a synchronized redraw received while a snapshot is restoring', () => {
  const harness = createHarness();
  let acknowledgements = 0;
  harness.sync.beginSnapshot('snapshot', {
    isCurrent: () => true,
    acknowledge: () => {
      acknowledgements += 1;
      return true;
    },
  });
  harness.sync.pushOutput('discarded before redraw');
  harness.sync.replaceScreen('redraw');
  harness.sync.pushOutput(' after redraw');
  assert.deepEqual(
    harness.writes.map(({ data }) => data),
    ['snapshot']
  );

  harness.writes[0].complete();
  assert.deepEqual(
    harness.writes.map(({ data }) => data),
    ['snapshot', 'redraw']
  );
  harness.writes[1].complete();
  harness.scheduler.flushFrame();
  assert.deepEqual(
    harness.writes.map(({ data }) => data),
    ['snapshot', 'redraw', ' after redraw']
  );
  harness.scheduler.flushFrame();
  assert.equal(acknowledgements, 1);
});

test('replaces a synchronized screen in one write without clearing scrollback', () => {
  const harness = createHarness();
  harness.sync.beginSnapshot('snapshot', { isCurrent: () => true, acknowledge: () => true });
  harness.sync.markScreenReady();
  harness.writes[0].complete();
  for (let index = 0; index < 4; index += 1) harness.scheduler.flushFrame();
  assert.deepEqual(harness.readyStates, [false, true]);

  harness.sync.replaceScreen('redraw');
  assert.equal(harness.resets, 1);
  assert.deepEqual(
    harness.writes.map(({ data }) => data),
    ['snapshot', 'redraw']
  );
  assert.deepEqual(harness.readyStates, [false, true, false]);

  harness.writes[1].complete();
  assert.deepEqual(harness.readyStates, [false, true, false, true]);
});

test('resets stale scrollback before an authoritative synchronized snapshot', () => {
  const harness = createHarness();
  harness.sync.beginSnapshot('snapshot', { isCurrent: () => true, acknowledge: () => true });
  harness.writes[0].complete();

  harness.sync.replaceScreen('authoritative snapshot', true);
  assert.equal(harness.resets, 1);
  assert.deepEqual(
    harness.writes.map(({ data }) => data),
    ['snapshot', '\u001bcauthoritative snapshot']
  );
  harness.writes[1].complete();
  assert.equal(harness.replacedScreens, 1);
});

test('applies the latest synchronized snapshot that arrives during a replacement write', () => {
  const harness = createHarness();
  harness.sync.beginSnapshot('snapshot', { isCurrent: () => true, acknowledge: () => true });
  harness.writes[0].complete();

  harness.sync.replaceScreen('first replacement', true);
  harness.sync.replaceScreen('latest replacement', true);
  assert.deepEqual(
    harness.writes.map(({ data }) => data),
    ['snapshot', '\u001bcfirst replacement']
  );

  harness.writes[1].complete();
  assert.equal(harness.resets, 1);
  assert.deepEqual(
    harness.writes.map(({ data }) => data),
    ['snapshot', '\u001bcfirst replacement', '\u001bclatest replacement']
  );
});

test('limits each render batch while preserving queued output order', () => {
  const harness = createHarness();
  const output = `${'x'.repeat(TERMINAL_OUTPUT_BATCH_CHARACTER_LIMIT)}tail`;
  harness.sync.beginSnapshot('snapshot', { isCurrent: () => true, acknowledge: () => true });
  harness.writes[0].complete();
  harness.sync.pushOutput(output);
  harness.scheduler.flushFrame();
  assert.equal(harness.writes[1].data, output.slice(0, TERMINAL_OUTPUT_BATCH_CHARACTER_LIMIT));

  harness.writes[1].complete();
  harness.scheduler.flushFrame();
  assert.equal(harness.writes[2].data, 'tail');
});

test('restores a large snapshot in bounded render batches', () => {
  const harness = createHarness();
  const snapshot = `${'x'.repeat(TERMINAL_OUTPUT_BATCH_CHARACTER_LIMIT)}tail`;
  harness.sync.beginSnapshot(snapshot, { isCurrent: () => true, acknowledge: () => true });
  assert.equal(harness.writes[0].data, snapshot.slice(0, TERMINAL_OUTPUT_BATCH_CHARACTER_LIMIT));

  harness.writes[0].complete();
  assert.equal(harness.writes.length, 1);
  harness.scheduler.flushFrame();
  assert.equal(harness.writes[1].data, 'tail');
});

test('reports snapshot restoration before acknowledging the server', () => {
  const harness = createHarness();
  const events: string[] = [];
  harness.sync.beginSnapshot('snapshot', {
    isCurrent: () => true,
    onRestored: () => events.push('restored'),
    acknowledge: () => {
      events.push('acknowledged');
      return true;
    },
  });
  assert.deepEqual(events, []);
  harness.writes[0].complete();
  assert.deepEqual(events, ['restored']);
  harness.scheduler.flushFrame();
  harness.scheduler.flushFrame();
  assert.deepEqual(events, ['restored', 'acknowledged']);
});

test('pauses output once the bounded backlog is exhausted', () => {
  const harness = createHarness();
  assert.equal(harness.sync.pushOutput('x'.repeat(TERMINAL_OUTPUT_BACKLOG_CHARACTER_LIMIT)), true);
  assert.equal(harness.sync.pushOutput('overflow'), false);
  assert.equal(harness.sync.pushOutput('ignored'), false);
  assert.equal(harness.overflows, 1);
  assert.equal(harness.writes.length, 0);
});

test('uses the reveal deadline when the server ready signal is delayed', () => {
  const harness = createHarness();
  harness.sync.beginSnapshot('snapshot', {
    isCurrent: () => true,
    acknowledge: () => true,
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
