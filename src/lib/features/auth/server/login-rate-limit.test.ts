import assert from 'node:assert/strict';
import test from 'node:test';
import {
  loginRateLimit,
  loginRetryAfter,
  recordLoginFailure,
  resetLoginFailures,
} from '~/lib/features/auth/server/login-rate-limit.server.ts';

test('temporarily blocks repeated login failures', () => {
  const key = `test-${Math.random()}`;
  const now = 1_000_000;
  for (let index = 0; index < loginRateLimit.MAX_FAILURES; index += 1) {
    recordLoginFailure(key, now + index);
  }
  assert.ok(loginRetryAfter(key, now + loginRateLimit.MAX_FAILURES) > 0);
  resetLoginFailures(key);
  assert.equal(loginRetryAfter(key, now), 0);
});
