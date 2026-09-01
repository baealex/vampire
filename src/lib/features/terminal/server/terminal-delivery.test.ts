import assert from 'node:assert/strict';
import test from 'node:test';

import { TerminalDeliveryBuffer } from './terminal-delivery.server.ts';

function output(sequence: number, value = `output-${sequence}`) {
  return { sequence, bytes: Buffer.byteLength(value), value };
}

test('delivers only post-snapshot output after browser acknowledgement', () => {
  const delivery = new TerminalDeliveryBuffer<string, string>(1_024);
  assert.deepEqual(delivery.enqueueOutput(output(10)), { outputs: [], overflowed: false });
  assert.deepEqual(delivery.enqueueOutput(output(11)), { outputs: [], overflowed: false });

  delivery.publishSnapshot(10);
  assert.deepEqual(delivery.enqueueOutput(output(12)), { outputs: [], overflowed: false });
  assert.deepEqual(delivery.acknowledge(), {
    outputs: [output(11), output(12)],
  });
});

test('orders an ACK-time screen reset before only the deltas beyond its fence', () => {
  const delivery = new TerminalDeliveryBuffer<string, string>(1_024);
  delivery.publishSnapshot(10);
  delivery.enqueueOutput(output(11));
  delivery.enqueueOutput(output(12));

  const generation = delivery.beginSynchronization();
  delivery.enqueueOutput(output(13));
  assert.deepEqual(delivery.completeSynchronization(generation, { throughSequence: 12, value: 'reset-12' }), {
    outputs: [],
  });
  assert.deepEqual(delivery.enqueueOutput(output(14)), { outputs: [], overflowed: false });

  assert.deepEqual(delivery.acknowledge(), {
    synchronization: { throughSequence: 12, value: 'reset-12' },
    outputs: [output(13), output(14)],
  });
});

test('holds live output behind an acknowledged synchronization transaction', () => {
  const delivery = new TerminalDeliveryBuffer<string, string>(1_024);
  delivery.publishSnapshot(20);
  delivery.acknowledge();

  const generation = delivery.beginSynchronization();
  assert.deepEqual(delivery.enqueueOutput(output(21)), { outputs: [], overflowed: false });
  assert.deepEqual(delivery.enqueueOutput(output(22)), { outputs: [], overflowed: false });
  assert.deepEqual(delivery.completeSynchronization(generation, { throughSequence: 21, value: 'reset-21' }), {
    synchronization: { throughSequence: 21, value: 'reset-21' },
    outputs: [output(22)],
  });
});

test('keeps a newer synchronization generation authoritative', () => {
  const delivery = new TerminalDeliveryBuffer<string, string>(1_024);
  delivery.publishSnapshot(30);
  delivery.acknowledge();
  const oldGeneration = delivery.beginSynchronization();
  const newGeneration = delivery.beginSynchronization();

  assert.deepEqual(delivery.completeSynchronization(oldGeneration, { throughSequence: 31, value: 'old' }), {
    outputs: [],
  });
  assert.deepEqual(delivery.completeSynchronization(newGeneration, { throughSequence: 32, value: 'new' }), {
    synchronization: { throughSequence: 32, value: 'new' },
    outputs: [],
  });
});

test('keeps output fenced when a stale synchronization is abandoned', () => {
  const delivery = new TerminalDeliveryBuffer<string, string>(1_024);
  delivery.publishSnapshot(40);
  delivery.acknowledge();

  const staleGeneration = delivery.beginSynchronization();
  delivery.enqueueOutput(output(41));
  assert.deepEqual(delivery.abandonSynchronization(staleGeneration), { outputs: [] });
  assert.deepEqual(delivery.enqueueOutput(output(42)), { outputs: [], overflowed: false });

  const currentGeneration = delivery.beginSynchronization();
  assert.deepEqual(delivery.completeSynchronization(currentGeneration, { throughSequence: 41, value: 'reset-41' }), {
    synchronization: { throughSequence: 41, value: 'reset-41' },
    outputs: [output(42)],
  });
});

test('bounds output held before a snapshot or synchronization ACK', () => {
  const delivery = new TerminalDeliveryBuffer<string, string>(5);
  assert.equal(delivery.enqueueOutput(output(1, '12345')).overflowed, false);
  assert.equal(delivery.enqueueOutput(output(2, '6')).overflowed, true);
});
