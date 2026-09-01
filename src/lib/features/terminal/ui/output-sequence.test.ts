import assert from 'node:assert/strict';
import test from 'node:test';

import { TerminalOutputSequence } from './output-sequence.ts';

test('accepts contiguous output after an authoritative snapshot fence', () => {
  const sequence = new TerminalOutputSequence();
  sequence.establish(7, 40);

  assert.equal(sequence.accept(7, { sequence: 41 }), true);
  assert.equal(sequence.accept(7, { sequence: 42 }), true);
  assert.equal(sequence.accept(7, { sequence: 44 }), false);
});

test('allows a synchronized snapshot to account for intentionally suppressed output', () => {
  const sequence = new TerminalOutputSequence();
  sequence.establish(7, 40);
  assert.equal(sequence.accept(7, { sequence: 41 }), true);
  assert.equal(sequence.accept(7, { screenSync: true, throughSequence: 48 }), true);
  assert.equal(sequence.accept(7, { sequence: 49 }), true);
  assert.equal(sequence.accept(7, { screenSync: true, throughSequence: 47 }), false);
});

test('keeps compatibility streams unsequenced and rejects mixed streams', () => {
  const sequence = new TerminalOutputSequence();
  sequence.establish(3, undefined);
  assert.equal(sequence.accept(3, {}), true);
  assert.equal(sequence.accept(3, { sequence: 1 }), false);

  sequence.establish(3, 4);
  assert.equal(sequence.accept(3, {}), false);
  sequence.reset();
  assert.equal(sequence.accept(4, {}), true);
});
