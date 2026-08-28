import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import test from 'node:test';
import type WebSocket from 'ws';
import {
  configureSessionAuthentication,
  createSessionCookie,
  revokeSession,
  SESSION_COOKIE_NAME,
} from './session-cookie.ts';
import { authorizeWebSocketUpgrade, scheduleAuthenticationExpiry, webSocketRequestUrl } from './websocket-support.ts';

function request(headers: IncomingMessage['headers']): IncomingMessage {
  return { headers } as IncomingMessage;
}

test('websocket origin checks ignore spoofed forwarded headers by default', () => {
  configureSessionAuthentication(false);
  const result = authorizeWebSocketUpgrade(
    request({
      host: 'localhost:7677',
      origin: 'https://localhost:7677',
      'x-forwarded-proto': 'https',
    }),
    {}
  );

  assert.deepEqual(result, { authorized: false, status: 403, reason: 'Forbidden' });
});

test('websocket origin checks use the configured public origin behind a proxy', () => {
  configureSessionAuthentication(true);
  const session = createSessionCookie();
  const result = authorizeWebSocketUpgrade(
    request({
      host: 'vampire.example.com',
      origin: 'https://vampire.example.com',
      cookie: `${SESSION_COOKIE_NAME}=${session.value}`,
    }),
    {
      VAMPIRE_PUBLIC_ORIGIN: 'https://vampire.example.com',
    }
  );

  assert.equal(result.authorized, true);
});

test('websocket authentication accepts a server session and rejects the raw TOKEN as a bearer credential', () => {
  configureSessionAuthentication(true);
  const headers = {
    host: 'localhost:7677',
    origin: 'http://localhost:7677',
  };

  assert.deepEqual(authorizeWebSocketUpgrade(request(headers), { VAMPIRE_HOST: '127.0.0.1' }), {
    authorized: false,
    status: 401,
    reason: 'Unauthorized',
  });
  assert.deepEqual(
    authorizeWebSocketUpgrade(request({ ...headers, authorization: 'Bearer correct horse battery staple' }), {
      VAMPIRE_HOST: '127.0.0.1',
    }),
    { authorized: false, status: 401, reason: 'Unauthorized' }
  );

  const session = createSessionCookie();
  assert.equal(
    authorizeWebSocketUpgrade(
      request({
        ...headers,
        cookie: `__Host-vampire_session=stale; ${SESSION_COOKIE_NAME}=${session.value}`,
      }),
      { VAMPIRE_HOST: '127.0.0.1' }
    ).authorized,
    true
  );
});

test('malformed websocket request targets are rejected without throwing', () => {
  assert.equal(webSocketRequestUrl({ url: 'http://[' } as IncomingMessage), undefined);
});

test('explicit proxy header configuration is opt-in', () => {
  configureSessionAuthentication(false);
  const result = authorizeWebSocketUpgrade(
    request({
      host: '127.0.0.1:7677',
      origin: 'https://127.0.0.1:7677',
      'x-forwarded-proto': 'https',
    }),
    { VAMPIRE_ADAPTER_PROTOCOL_HEADER: 'x-forwarded-proto', VAMPIRE_HOST: '127.0.0.1' }
  );

  assert.equal(result.authorized, true);
});

test('websocket origin checks reject DNS-rebinding hostnames even in explicit no-auth mode', () => {
  configureSessionAuthentication(false);

  assert.deepEqual(
    authorizeWebSocketUpgrade(request({ host: 'attacker.example:7677', origin: 'http://attacker.example:7677' }), {
      VAMPIRE_HOST: '127.0.0.1',
    }),
    { authorized: false, status: 403, reason: 'Forbidden' }
  );
});

test('revoking an authenticated session closes its active websocket', () => {
  configureSessionAuthentication(true);
  const session = createSessionCookie();
  const authorization = authorizeWebSocketUpgrade(
    request({
      host: 'localhost:7677',
      origin: 'http://localhost:7677',
      cookie: `${SESSION_COOKIE_NAME}=${session.value}`,
    }),
    { VAMPIRE_HOST: '127.0.0.1' }
  );
  assert.equal(authorization.authorized, true);
  if (!authorization.authorized) throw new Error('Expected an authenticated websocket.');

  const socket = new EventEmitter() as EventEmitter & {
    close: (code: number, reason: string) => void;
    closed?: { code: number; reason: string };
    readyState: number;
    terminate: () => void;
  };
  socket.readyState = 1;
  socket.close = (code, reason) => {
    socket.closed = { code, reason };
    socket.readyState = 2;
  };
  socket.terminate = () => {
    socket.readyState = 3;
  };
  const authentication = scheduleAuthenticationExpiry(
    socket as WebSocket,
    authorization.expiresAt,
    authorization.sessionId
  );
  let acceptedMessages = 0;
  let revocationNotified = false;
  authentication.onRevoked(() => {
    revocationNotified = true;
  });
  socket.on('message', () => {
    if (authentication.isAuthorized()) acceptedMessages += 1;
  });

  revokeSession(session.value);
  socket.emit('message', 'command-after-revoke');
  socket.emit('close');

  assert.deepEqual(socket.closed, { code: 1008, reason: 'authentication revoked' });
  assert.equal(authentication.isAuthorized(), false);
  assert.equal(revocationNotified, true);
  assert.equal(acceptedMessages, 0);
});

test('force-terminates an authenticated peer that ignores the revocation close frame', async () => {
  configureSessionAuthentication(true);
  const session = createSessionCookie();
  const authorized = authorizeWebSocketUpgrade(
    request({
      host: 'localhost:7677',
      origin: 'http://localhost:7677',
      cookie: `${SESSION_COOKIE_NAME}=${session.value}`,
    }),
    { VAMPIRE_HOST: '127.0.0.1' }
  );
  assert.equal(authorized.authorized, true);
  if (!authorized.authorized) throw new Error('Expected an authenticated websocket.');

  const socket = new EventEmitter() as EventEmitter & {
    close: () => void;
    readyState: number;
    terminate: () => void;
  };
  socket.readyState = 1;
  socket.close = () => {
    socket.readyState = 2;
  };
  socket.terminate = () => {
    socket.readyState = 3;
    socket.emit('close');
  };
  scheduleAuthenticationExpiry(socket as WebSocket, authorized.expiresAt, authorized.sessionId);

  revokeSession(session.value);
  assert.equal(socket.readyState, 2);
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.equal(socket.readyState, 3);
});
