import assert from 'node:assert/strict';
import test from 'node:test';
import type { RequestEvent } from '@sveltejs/kit';
import { handle } from './hooks.server.ts';
import {
  configureSessionAuthentication,
  createSessionCookie,
  SESSION_COOKIE_NAME,
} from '~/lib/server/session-cookie.ts';

function requestEvent(path: string, sessionCookie?: string, authorization?: string): RequestEvent {
  const url = new URL(path, 'http://localhost:7677');
  const headers = authorization ? { authorization } : undefined;
  return {
    cookies: {
      get: (name: string) => (name === SESSION_COOKIE_NAME ? sessionCookie : undefined),
    },
    request: new Request(url, { headers }),
    url,
  } as RequestEvent;
}

const resolve = async () => new Response('resolved');

test('the server hook denies every non-public API without a session', async () => {
  configureSessionAuthentication(true);

  await assert.rejects(
    async () =>
      handle({
        event: requestEvent('/api/workspaces', undefined, 'Bearer correct horse battery staple'),
        resolve,
      }),
    (cause: unknown) => {
      assert.equal((cause as { status?: number }).status, 401);
      return true;
    }
  );
});

test('the server hook admits an authenticated API session', async () => {
  configureSessionAuthentication(true);
  const session = createSessionCookie();

  const response = await handle({ event: requestEvent('/api/workspaces', session.value), resolve });

  assert.equal(await response.text(), 'resolved');
});

test('the server hook leaves only login and status APIs public', async () => {
  configureSessionAuthentication(true);

  for (const path of ['/api/login', '/api/status']) {
    const response = await handle({ event: requestEvent(path), resolve });
    assert.equal(await response.text(), 'resolved');
  }
});
