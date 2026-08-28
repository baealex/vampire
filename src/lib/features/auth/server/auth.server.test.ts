import assert from 'node:assert/strict';
import test from 'node:test';
import type { RequestEvent } from '@sveltejs/kit';
import { authenticate, authenticationRequired, clearAuthentication, isAuthenticated } from './auth.server.ts';
import { loginRateLimit } from './login-rate-limit.server.ts';
import { initializeAuthentication, verifyConfiguredToken } from '~/lib/server/token-authentication.ts';

function loginEvent(token: string, values = new Map<string, string>()): RequestEvent {
  const url = new URL('http://localhost:7677/api/login');
  return {
    cookies: {
      delete: (name: string) => values.delete(name),
      get: (name: string) => values.get(name),
      set: (name: string, value: string) => values.set(name, value),
    },
    getClientAddress: () => 'test-client',
    request: new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    }),
    url,
  } as unknown as RequestEvent;
}

function rawLoginEvent(body: string, client = 'test-client'): RequestEvent {
  const url = new URL('http://localhost:7677/api/login');
  return {
    cookies: {
      delete: () => undefined,
      get: () => undefined,
      set: () => undefined,
    },
    getClientAddress: () => client,
    request: new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    }),
    url,
  } as unknown as RequestEvent;
}

function stalledLoginEvent(client = 'stalled-client'): RequestEvent {
  const url = new URL('http://localhost:7677/api/login');
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"token":"unfinished'));
    },
  });
  return {
    cookies: {
      delete: () => undefined,
      get: () => undefined,
      set: () => undefined,
    },
    getClientAddress: () => client,
    request: new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' }),
    url,
  } as unknown as RequestEvent;
}

test('hashes the configured TOKEN and removes the plaintext environment value', async () => {
  const env: NodeJS.ProcessEnv = { VAMPIRE_TOKEN: 'correct horse battery staple' };

  await initializeAuthentication(env);

  assert.equal(env.VAMPIRE_TOKEN, undefined);
  assert.equal(authenticationRequired(), true);
  assert.equal(await verifyConfiguredToken('correct horse battery staple'), true);
  assert.equal(await verifyConfiguredToken('wrong password'), false);
});

test('supports an explicit no-auth runtime without retaining an old verifier', async () => {
  await initializeAuthentication({});

  assert.equal(authenticationRequired(), false);
  assert.equal(await verifyConfiguredToken('correct horse battery staple'), false);
});

test('exchanges the configured TOKEN for a revocable server session', async () => {
  await initializeAuthentication({ VAMPIRE_TOKEN: 'correct horse battery staple' });
  const values = new Map<string, string>();
  const event = loginEvent('correct horse battery staple', values);

  await authenticate(event);

  assert.equal(isAuthenticated(event), true);
  clearAuthentication(event);
  assert.equal(isAuthenticated(event), false);
});

test('accepts the maximum TOKEN size even when JSON escaping expands the body', async () => {
  const token = '\\'.repeat(4 * 1024);
  await initializeAuthentication({ VAMPIRE_TOKEN: token });
  const event = loginEvent(token);

  await authenticate(event);

  assert.equal(isAuthenticated(event), true);
});

test('does not turn concurrent malformed login requests into a global credential lockout', async () => {
  await initializeAuthentication({ VAMPIRE_TOKEN: 'correct horse battery staple' });
  const attempts = await Promise.allSettled(
    Array.from({ length: 30 }, (_, index) => authenticate(rawLoginEvent('{', `malformed-${index}`)))
  );
  const statuses = attempts.flatMap((attempt) =>
    attempt.status === 'rejected' ? [(attempt.reason as { status?: number }).status] : []
  );
  assert.equal(
    statuses.every((status) => status === 401 || status === 429),
    true
  );
  assert.equal(statuses.includes(429), true);

  const validLogin = loginEvent('correct horse battery staple');
  await authenticate(validLogin);
  assert.equal(isAuthenticated(validLogin), true);
});

test('does not treat one untrusted reverse-proxy address as a per-client login lockout', async () => {
  const previousPublicOrigin = process.env.VAMPIRE_PUBLIC_ORIGIN;
  const previousAdapterOrigin = process.env.VAMPIRE_ADAPTER_ORIGIN;
  const previousAddressHeader = process.env.VAMPIRE_ADAPTER_ADDRESS_HEADER;
  process.env.VAMPIRE_PUBLIC_ORIGIN = 'https://vampire.example.com';
  delete process.env.VAMPIRE_ADAPTER_ORIGIN;
  delete process.env.VAMPIRE_ADAPTER_ADDRESS_HEADER;

  try {
    await initializeAuthentication({ VAMPIRE_TOKEN: 'correct horse battery staple' });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await assert.rejects(
        () => authenticate(loginEvent('wrong password', new Map())),
        (cause: unknown) => (cause as { status?: number }).status === 401
      );
    }

    const validLogin = loginEvent('correct horse battery staple');
    await authenticate(validLogin);
    assert.equal(isAuthenticated(validLogin), true);
  } finally {
    if (previousPublicOrigin === undefined) delete process.env.VAMPIRE_PUBLIC_ORIGIN;
    else process.env.VAMPIRE_PUBLIC_ORIGIN = previousPublicOrigin;
    if (previousAdapterOrigin === undefined) delete process.env.VAMPIRE_ADAPTER_ORIGIN;
    else process.env.VAMPIRE_ADAPTER_ORIGIN = previousAdapterOrigin;
    if (previousAddressHeader === undefined) delete process.env.VAMPIRE_ADAPTER_ADDRESS_HEADER;
    else process.env.VAMPIRE_ADAPTER_ADDRESS_HEADER = previousAddressHeader;
  }
});

test('bounds and times out stalled login bodies without leaking admission slots', { timeout: 10_000 }, async () => {
  await initializeAuthentication({ VAMPIRE_TOKEN: 'correct horse battery staple' });
  const startedAt = Date.now();
  const stalledAttempts = Array.from({ length: loginRateLimit.MAX_CONCURRENT_LOGIN_REQUESTS }, (_, index) =>
    authenticate(stalledLoginEvent(`stalled-client-${index}`))
  );

  await assert.rejects(
    () => authenticate(stalledLoginEvent('overflow-client')),
    (cause: unknown) => (cause as { status?: number }).status === 429
  );
  const results = await Promise.allSettled(stalledAttempts);
  assert.equal(
    results.every((result) => result.status === 'rejected' && (result.reason as { status?: number }).status === 408),
    true
  );
  assert.ok(Date.now() - startedAt >= 4_500);

  const validLogin = loginEvent('correct horse battery staple');
  await authenticate(validLogin);
  assert.equal(isAuthenticated(validLogin), true);
});
