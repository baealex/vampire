import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TerminalConnection,
  TERMINAL_READY_TIMEOUT_MS,
  TERMINAL_STABLE_READY_MS,
  terminalCloseIsRetryable,
  type TerminalConnectionContext,
  type TerminalSocket,
} from '~/lib/features/terminal/api/connection.ts';
import type { TerminalServerMessage } from '~/lib/shared/contracts/terminal-protocol.ts';

class FakeScheduler {
  now = 0;
  nextId = 0;
  timers = new Map<number, { at: number; callback: () => void }>();

  setTimeout = (callback: () => void, delay: number): number => {
    const id = ++this.nextId;
    this.timers.set(id, { at: this.now + delay, callback });
    return id;
  };

  clearTimeout = (id: unknown): void => {
    this.timers.delete(id as number);
  };

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

class FakeSocket implements TerminalSocket {
  readyState = 0;
  readonly url: string;
  sent: string[] = [];
  onopen: TerminalSocket['onopen'] = null;
  onmessage: TerminalSocket['onmessage'] = null;
  onerror: TerminalSocket['onerror'] = null;
  onclose: TerminalSocket['onclose'] = null;

  constructor(url: string) {
    this.url = url;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  message(data: unknown): void {
    this.onmessage?.({ data });
  }

  disconnect(code: number, reason: string): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ''): void {
    this.disconnect(code, reason);
  }
}

function createHarness() {
  const scheduler = new FakeScheduler();
  const sockets: FakeSocket[] = [];
  const opened: TerminalConnectionContext[] = [];
  const messages: Array<{ message: TerminalServerMessage; context: TerminalConnectionContext }> = [];
  const disconnects: Array<{ event: { code: number; reason: string }; retrying: boolean }> = [];
  const retryDelays: number[] = [];
  let reconnectExhausted = 0;
  let protocolErrors = 0;
  const connection = new TerminalConnection(
    'ws://example.test/terminal',
    {
      onOpen: (context) => opened.push(context),
      onMessage: (message, context) => messages.push({ message, context }),
      onDisconnect: (event, retrying) => disconnects.push({ event, retrying }),
      onRetrying: (delay) => retryDelays.push(delay),
      onReconnectExhausted: () => {
        reconnectExhausted += 1;
      },
      onProtocolError: () => {
        protocolErrors += 1;
      },
    },
    {
      createSocket: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
      setTimeout: scheduler.setTimeout,
      clearTimeout: scheduler.clearTimeout,
    }
  );
  return {
    connection,
    scheduler,
    sockets,
    opened,
    messages,
    disconnects,
    retryDelays,
    get reconnectExhausted() {
      return reconnectExhausted;
    },
    get protocolErrors() {
      return protocolErrors;
    },
  };
}

test('reconnects after transient closes and ignores messages from replaced sockets', () => {
  const harness = createHarness();
  harness.connection.start();
  assert.equal(harness.sockets.length, 1);
  assert.equal(harness.connection.send({ type: 'activate' }), false);

  const firstSocket = harness.sockets[0];
  firstSocket.open();
  assert.equal(harness.opened.length, 1);
  assert.equal(harness.connection.send({ type: 'input', data: 'hello' }), true);
  assert.deepEqual(JSON.parse(firstSocket.sent[0]), { type: 'input', data: 'hello' });
  firstSocket.message('{"type":"output","data":"ready","activity":true,"activityAt":1000}');
  assert.equal(harness.messages.length, 1);
  const firstContext = harness.messages[0].context;

  firstSocket.disconnect(1011, 'temporary failure');
  assert.equal(harness.disconnects[0].retrying, true);
  assert.deepEqual(harness.retryDelays, [500]);
  harness.scheduler.advance(499);
  assert.equal(harness.sockets.length, 1);
  harness.scheduler.advance(1);
  assert.equal(harness.sockets.length, 2);
  assert.equal(firstContext.isCurrent(), false);
  assert.equal(firstContext.send({ type: 'snapshot-ready' }), false);
  firstSocket.message('{"type":"output","data":"stale","activity":true,"activityAt":1001}');
  assert.equal(harness.messages.length, 1);

  harness.sockets[1].open();
  harness.sockets[1].message('not-json');
  assert.equal(harness.protocolErrors, 1);
  harness.connection.stop();
});

test('restarts a gapped stream through the bounded reconnect backoff', () => {
  const harness = createHarness();
  harness.connection.start();
  const firstSocket = harness.sockets[0];
  firstSocket.open();

  harness.connection.restart('terminal output sequence gap');

  assert.equal(firstSocket.readyState, 3);
  assert.equal(harness.sockets.length, 1);
  assert.deepEqual(harness.retryDelays, [500]);
  harness.scheduler.advance(500);
  assert.equal(harness.sockets.length, 2);
  assert.deepEqual(harness.disconnects, []);
  harness.connection.stop();
});

test('does not restart a gapped stream while retry is suspended', () => {
  const harness = createHarness();
  harness.connection.start();
  harness.sockets[0].open();
  harness.connection.setRetryEnabled(false);

  harness.connection.restart('terminal output sequence gap');
  harness.scheduler.advance(60_000);
  assert.equal(harness.sockets.length, 1);

  harness.connection.setRetryEnabled(true);
  assert.equal(harness.sockets.length, 2);
  harness.connection.stop();
});

test('does not reconnect after authentication or rate-limit policy closes', () => {
  assert.equal(terminalCloseIsRetryable({ code: 1008, reason: 'authentication expired' }), false);
  assert.equal(terminalCloseIsRetryable({ code: 1008, reason: 'authentication revoked' }), false);
  assert.equal(terminalCloseIsRetryable({ code: 1008, reason: 'message rate exceeded' }), false);
  assert.equal(terminalCloseIsRetryable({ code: 1009, reason: 'terminal screen exceeds limit' }), false);
  assert.equal(terminalCloseIsRetryable({ code: 1008, reason: 'other policy' }), true);

  const harness = createHarness();
  harness.connection.start();
  harness.sockets[0].open();
  harness.sockets[0].disconnect(1008, 'authentication expired');
  assert.equal(harness.disconnects[0].retrying, false);
  harness.scheduler.advance(60_000);
  assert.equal(harness.sockets.length, 1);
});

test('stops reconnecting after repeated failures and allows a manual retry', () => {
  const harness = createHarness();
  harness.connection.start();
  harness.sockets[0].open();

  for (const delay of [500, 1_000, 2_000, 4_000, 8_000]) {
    harness.sockets.at(-1)!.disconnect(1011, 'temporary failure');
    harness.scheduler.advance(delay);
  }
  assert.equal(harness.sockets.length, 6);
  assert.deepEqual(harness.retryDelays, [500, 1_000, 2_000, 4_000, 8_000]);

  harness.sockets.at(-1)!.disconnect(1011, 'temporary failure');
  assert.equal(harness.reconnectExhausted, 1);
  assert.equal(harness.sockets.length, 6);

  harness.connection.retryNow();
  assert.equal(harness.sockets.length, 7);
  harness.connection.stop();
});

test('does not reset backoff for sockets that open but never become ready', () => {
  const harness = createHarness();
  harness.connection.start();

  for (const delay of [500, 1_000, 2_000, 4_000, 8_000]) {
    const socket = harness.sockets.at(-1)!;
    socket.open();
    socket.disconnect(1011, 'terminal unavailable');
    harness.scheduler.advance(delay);
  }
  const last = harness.sockets.at(-1)!;
  last.open();
  last.disconnect(1011, 'terminal unavailable');

  assert.equal(harness.reconnectExhausted, 1);
  assert.equal(harness.sockets.length, 6);
  harness.connection.stop();
});

test('abandons a socket that stays open without ever producing a ready screen', () => {
  const harness = createHarness();
  harness.connection.start();
  const socket = harness.sockets[0];
  socket.open();

  harness.scheduler.advance(TERMINAL_READY_TIMEOUT_MS - 1);
  assert.equal(socket.readyState, 1);
  harness.scheduler.advance(1);
  assert.equal(socket.readyState, 3);
  assert.deepEqual(harness.disconnects, [
    {
      event: { code: 4_000, reason: 'terminal ready timeout' },
      retrying: true,
    },
  ]);
  assert.deepEqual(harness.retryDelays, [500]);

  harness.scheduler.advance(500);
  assert.equal(harness.sockets.length, 2);
  harness.connection.stop();
});

test('resets reconnect backoff only after the terminal screen is ready', () => {
  const harness = createHarness();
  harness.connection.start();
  harness.sockets[0].open();
  harness.sockets[0].disconnect(1011, 'temporary failure');
  harness.scheduler.advance(500);
  harness.sockets[1].open();
  harness.sockets[1].disconnect(1011, 'temporary failure');
  harness.scheduler.advance(1_000);
  harness.sockets[2].open();
  harness.connection.markReady(harness.opened.at(-1)!);
  harness.scheduler.advance(TERMINAL_STABLE_READY_MS);
  assert.equal(harness.sockets[2].readyState, 1);
  harness.sockets[2].disconnect(1011, 'temporary failure');

  assert.deepEqual(harness.retryDelays, [500, 1_000, 500]);
  harness.connection.stop();
});

test('suspends reconnects while a terminal page is hidden', () => {
  const harness = createHarness();
  harness.connection.setRetryEnabled(false);
  harness.connection.start();
  assert.equal(harness.sockets.length, 0);

  harness.connection.setRetryEnabled(true);
  assert.equal(harness.sockets.length, 1);
  harness.sockets[0].open();
  harness.sockets[0].disconnect(1011, 'background suspension');
  harness.connection.setRetryEnabled(false);
  harness.scheduler.advance(60_000);
  assert.equal(harness.sockets.length, 1);

  harness.connection.setRetryEnabled(true);
  harness.scheduler.advance(1_000);
  assert.equal(harness.sockets.length, 2);
  harness.connection.stop();
});

test('resolves a fresh WebSocket URL for each connection attempt', () => {
  let active = false;
  const sockets: FakeSocket[] = [];
  const connection = new TerminalConnection(
    () => `ws://example.test/terminal?active=${active ? '1' : '0'}`,
    {},
    {
      createSocket: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
    }
  );
  connection.start();
  assert.match(sockets[0].url, /active=0/);
  sockets[0].open();
  sockets[0].disconnect(1011, 'temporary failure');
  active = true;
  connection.retryNow();
  assert.match(sockets[1].url, /active=1/);
  connection.stop();
});
