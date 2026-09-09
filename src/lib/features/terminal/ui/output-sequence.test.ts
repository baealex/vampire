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

test('rejects gaps in the raw output stream after a snapshot fence', () => {
  const sequence = new TerminalOutputSequence();
  sequence.establish(7, 40);
  assert.equal(sequence.accept(7, { sequence: 41 }), true);
  assert.equal(sequence.accept(7, { sequence: 43 }), false);
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
