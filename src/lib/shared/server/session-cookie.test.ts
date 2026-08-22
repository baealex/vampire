import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionCookie, isSessionCookieValid, parseCookie, sessionCookieExpiresAt } from './session-cookie.ts';

test('creates signed expiring workspace cookies', () => {
  const token = 'a-long-random-test-token';
  const workspace = createSessionCookie(token);
  assert.equal(isSessionCookieValid(workspace.value, token), true);
  assert.equal(isSessionCookieValid(workspace.value, `${token}-wrong`), false);
  assert.ok((sessionCookieExpiresAt(workspace.value, token) ?? 0) > Date.now());
});

test('ignores malformed percent escapes in cookie headers', () => {
  assert.deepEqual(parseCookie('good=value; broken=%E0%A4%A'), { good: 'value' });
});
