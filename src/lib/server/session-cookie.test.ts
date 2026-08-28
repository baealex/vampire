import assert from 'node:assert/strict';
import test from 'node:test';
import {
  authorizeSession,
  configureSessionAuthentication,
  createSessionCookie,
  onSessionRevoked,
  parseCookie,
  revokeSession,
} from './session-cookie.ts';

test('creates opaque server sessions that expire and can be revoked', () => {
  configureSessionAuthentication(true);
  const now = 1_000_000;
  const session = createSessionCookie(now);
  const authorized = authorizeSession(session.value, now);

  assert.equal(authorized.authorized, true);
  assert.ok(authorized.authorized && authorized.sessionId);
  assert.equal(authorized.authorized && authorized.expiresAt, session.expiresAt);
  assert.deepEqual(authorizeSession(session.value, session.expiresAt), { authorized: false });

  revokeSession(session.value);
  assert.deepEqual(authorizeSession(session.value, now), { authorized: false });
});

test('notifies active transports when their session is revoked', () => {
  configureSessionAuthentication(true);
  const session = createSessionCookie();
  const authorized = authorizeSession(session.value);
  assert.equal(authorized.authorized, true);
  if (!authorized.authorized || !authorized.sessionId) throw new Error('Expected a server session.');

  let revoked = false;
  const unsubscribe = onSessionRevoked(authorized.sessionId, () => {
    revoked = true;
  });
  revokeSession(session.value);
  unsubscribe();

  assert.equal(revoked, true);
});

test('fails closed until authentication is explicitly disabled', () => {
  configureSessionAuthentication(true);
  assert.deepEqual(authorizeSession(undefined), { authorized: false });

  configureSessionAuthentication(false);
  assert.deepEqual(authorizeSession(undefined), { authorized: true });
});

test('ignores malformed percent escapes in cookie headers', () => {
  assert.deepEqual(parseCookie('good=value; broken=%E0%A4%A'), { good: 'value' });
});
