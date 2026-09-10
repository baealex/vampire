import assert from 'node:assert/strict';
import test from 'node:test';
import { configureSessionAuthentication } from '~/lib/server/session-cookie.ts';
import { initializeAuthentication } from '~/lib/server/token-authentication.ts';
import { createFastifyApp } from './fastify-app.server.ts';

test('Fastify foundation serves health with the existing security headers', async () => {
  configureSessionAuthentication(false);
  const app = createFastifyApp();
  const response = await app.inject({ method: 'GET', url: '/health' });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: 'ok' });
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['x-frame-options'], 'DENY');
  await app.close();
});

test('Fastify foundation preserves Host and mutating Origin protection', async () => {
  configureSessionAuthentication(false);
  const app = createFastifyApp();

  assert.equal(
    (await app.inject({ method: 'GET', url: '/health', headers: { host: 'attacker.example' } })).statusCode,
    421
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/missing',
        headers: { host: 'localhost', origin: 'https://attacker.example' },
      })
    ).statusCode,
    403
  );
  await app.close();
});

test('Fastify status keeps the public unauthenticated response contract', async () => {
  configureSessionAuthentication(true);
  const app = createFastifyApp();
  const response = await app.inject({ method: 'GET', url: '/api/status' });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { authenticationRequired: true, authenticated: false, tmux: null });
  assert.equal(response.headers['cache-control'], 'no-store');
  await app.close();
});

test('Fastify route adapter preserves protected API and event-stream authentication', async () => {
  configureSessionAuthentication(true);
  const app = createFastifyApp();

  const apiResponse = await app.inject({ method: 'GET', url: '/api/system' });
  const eventResponse = await app.inject({ method: 'GET', url: '/events/workspaces' });

  assert.equal(apiResponse.statusCode, 401);
  assert.deepEqual(apiResponse.json(), { message: 'Unauthorized' });
  assert.equal(eventResponse.statusCode, 401);
  assert.deepEqual(eventResponse.json(), { message: 'Unauthorized' });
  await app.close();
});

test('Fastify protects unmatched API spellings before returning not found', async () => {
  configureSessionAuthentication(true);
  const app = createFastifyApp();

  const response = await app.inject({ method: 'GET', url: '/api/workspaces/' });

  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.json(), { message: 'Unauthorized' });
  await app.close();
});

test('Fastify derives secure login cookies from the configured public origin', async () => {
  const previousPublicOrigin = process.env.VAMPIRE_PUBLIC_ORIGIN;
  const previousAdapterOrigin = process.env.VAMPIRE_ADAPTER_ORIGIN;
  process.env.VAMPIRE_PUBLIC_ORIGIN = 'https://vampire.example.com:8443';
  process.env.VAMPIRE_ADAPTER_ORIGIN = 'https://vampire.example.com:8443';
  await initializeAuthentication({ VAMPIRE_TOKEN: 'fastify-public-origin-token' });
  const app = createFastifyApp();

  try {
    const login = await app.inject({
      method: 'POST',
      url: '/api/login',
      headers: {
        host: 'vampire.example.com:8443',
        origin: 'https://vampire.example.com:8443',
        'content-type': 'application/json',
      },
      payload: { token: 'fastify-public-origin-token' },
    });
    assert.equal(login.statusCode, 200);
    const setCookies = Array.isArray(login.headers['set-cookie'])
      ? login.headers['set-cookie']
      : [login.headers['set-cookie']];
    const secureCookie = setCookies.find((value) => /^__Host-vampire_session=[^;]/u.test(value ?? ''));
    assert.match(secureCookie ?? '', /; Secure;/u);

    const authenticated = await app.inject({
      method: 'GET',
      url: '/api/not-a-route',
      headers: {
        host: 'vampire.example.com:8443',
        cookie: secureCookie?.split(';', 1)[0],
      },
    });
    assert.equal(authenticated.statusCode, 404);
  } finally {
    await app.close();
    configureSessionAuthentication(false);
    if (previousPublicOrigin === undefined) delete process.env.VAMPIRE_PUBLIC_ORIGIN;
    else process.env.VAMPIRE_PUBLIC_ORIGIN = previousPublicOrigin;
    if (previousAdapterOrigin === undefined) delete process.env.VAMPIRE_ADAPTER_ORIGIN;
    else process.env.VAMPIRE_ADAPTER_ORIGIN = previousAdapterOrigin;
  }
});
