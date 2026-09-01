import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMPACT_RESIZE_INITIAL_CADENCE_MS,
  COMPACT_RESIZE_MAX_SETTLE_MS,
  compactTerminalResizeSettleDelay,
  nextTerminalResizeCadence,
} from './resize-scheduling.ts';

test('keeps a browser-independent quiet window at 60, 90, and 120Hz', () => {
  for (const frameInterval of [17, 11, 8]) {
    let cadence = COMPACT_RESIZE_INITIAL_CADENCE_MS;
    for (let sample = 0; sample < 8; sample += 1) {
      cadence = nextTerminalResizeCadence(cadence, frameInterval);
    }
    const settleDelay = compactTerminalResizeSettleDelay(cadence);
    assert.ok(settleDelay >= 64, `${frameInterval}ms cadence settled too early`);
    assert.ok(settleDelay >= frameInterval * 3, `${frameInterval}ms cadence settled inside the resize burst`);
    assert.ok(settleDelay <= COMPACT_RESIZE_MAX_SETTLE_MS);
  }
});

test('does not mistake a dropped high-refresh frame for a settled viewport', () => {
  let cadence = COMPACT_RESIZE_INITIAL_CADENCE_MS;
  let previous = 0;
  for (const observedAt of [8, 31, 39, 73]) {
    cadence = nextTerminalResizeCadence(cadence, observedAt - previous);
    previous = observedAt;
  }
  assert.ok(compactTerminalResizeSettleDelay(cadence) >= 64);
});

test('ignores initialization noise and idle gaps in resize cadence', () => {
  assert.equal(nextTerminalResizeCadence(12, 2), 12);
  assert.equal(nextTerminalResizeCadence(12, 101), 12);
  assert.equal(nextTerminalResizeCadence(12, 10), 11);
});
