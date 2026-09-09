import assert from 'node:assert/strict';
import test from 'node:test';

import { TerminalDeliveryBuffer } from './terminal-delivery.server.ts';

function output(sequence: number, value = `output-${sequence}`) {
  return { sequence, bytes: Buffer.byteLength(value), value };
}

test('delivers only post-snapshot output after browser acknowledgement', () => {
  const delivery = new TerminalDeliveryBuffer<string>(1_024);
  assert.deepEqual(delivery.enqueueOutput(output(10)), { outputs: [], overflowed: false });
  assert.deepEqual(delivery.enqueueOutput(output(11)), { outputs: [], overflowed: false });

  delivery.publishSnapshot(10);
  assert.deepEqual(delivery.enqueueOutput(output(12)), { outputs: [], overflowed: false });
  assert.deepEqual(delivery.acknowledge(), {
    outputs: [output(11), output(12)],
  });
});

test('sends acknowledged raw output directly and ignores already fenced sequences', () => {
  const delivery = new TerminalDeliveryBuffer<string>(1_024);
  delivery.publishSnapshot(20);
  assert.deepEqual(delivery.acknowledge(), { outputs: [] });

  assert.deepEqual(delivery.enqueueOutput(output(20)), { outputs: [], overflowed: false });
  assert.deepEqual(delivery.enqueueOutput(output(21)), { outputs: [output(21)], overflowed: false });
});

test('bounds output held before a snapshot or acknowledgement', () => {
  const delivery = new TerminalDeliveryBuffer<string>(5);
  assert.equal(delivery.enqueueOutput(output(1, '12345')).overflowed, false);
  assert.equal(delivery.enqueueOutput(output(2, '6')).overflowed, true);
});
