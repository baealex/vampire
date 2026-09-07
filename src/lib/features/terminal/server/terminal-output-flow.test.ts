import assert from 'node:assert/strict';
import test from 'node:test';
import { TerminalOutputFlow } from './terminal-output-flow.server.ts';

test('bounds bytes until a matching pong and requires an authoritative reset after skipped output', () => {
  const flow = new TerminalOutputFlow(100);
  assert.equal(flow.canSend(false), true);
  assert.equal(flow.sent(60), undefined);
  assert.equal(flow.canSend(false), true);
  const ping = flow.sent(60)!;
  assert.equal(flow.canSend(false), false);
  assert.equal(flow.canSend(true), false);
  assert.equal(flow.acknowledge('unrelated-heartbeat'), false);
  assert.equal(flow.needsSynchronization, false);
  assert.equal(flow.acknowledge(ping), true);
  assert.equal(flow.needsSynchronization, true);
  assert.equal(flow.canSend(false), false);
  assert.equal(flow.canSend(true), true);
  assert.equal(flow.needsSynchronization, false);
  assert.equal(flow.sent(110), 'vampire-output-2');
  assert.equal(flow.acknowledge(ping), false);
});

test('does not reset an uninterrupted stream or couple subscribers', () => {
  const slow = new TerminalOutputFlow(10);
  const fast = new TerminalOutputFlow(10);
  const ping = slow.sent(10)!;
  assert.equal(slow.canSend(false), false);
  assert.equal(fast.canSend(false), true);
  const fastPing = fast.sent(10)!;
  assert.equal(fast.acknowledge(fastPing), false);
  assert.equal(fast.canSend(false), true);
  assert.equal(slow.acknowledge(ping), true);
});
