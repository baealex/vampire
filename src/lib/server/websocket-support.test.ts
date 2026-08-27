import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import test from 'node:test';
import { authorizeWebSocketUpgrade } from './websocket-support.ts';

function request(headers: IncomingMessage['headers']): IncomingMessage {
  return { headers } as IncomingMessage;
}

test('websocket origin checks ignore spoofed forwarded headers by default', () => {
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
  const result = authorizeWebSocketUpgrade(
    request({
      host: 'internal:7677',
      origin: 'https://vampire.example.com',
      authorization: 'Bearer secret-token',
    }),
    {
      VAMPIRE_PUBLIC_ORIGIN: 'https://vampire.example.com',
      VAMPIRE_TOKEN: 'secret-token',
    }
  );

  assert.equal(result.authorized, true);
});

test('websocket authentication reads the same runtime token accessor', () => {
  const headers = {
    host: 'localhost:7677',
    origin: 'http://localhost:7677',
  };

  assert.deepEqual(authorizeWebSocketUpgrade(request(headers), { VAMPIRE_TOKEN: 'secret-token' }), {
    authorized: false,
    status: 401,
    reason: 'Unauthorized',
  });
  assert.equal(
    authorizeWebSocketUpgrade(request({ ...headers, authorization: 'Bearer secret-token' }), {
      VAMPIRE_TOKEN: 'secret-token',
    }).authorized,
    true
  );
});

test('explicit proxy header configuration is opt-in', () => {
  const result = authorizeWebSocketUpgrade(
    request({
      host: 'vampire.example.com',
      origin: 'https://vampire.example.com',
      'x-forwarded-proto': 'https',
    }),
    { VAMPIRE_ADAPTER_PROTOCOL_HEADER: 'x-forwarded-proto' }
  );

  assert.equal(result.authorized, true);
});
