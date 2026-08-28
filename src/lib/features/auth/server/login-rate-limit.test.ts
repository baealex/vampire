import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acquireLoginAdmission,
  loginRateLimit,
  loginRetryAfter,
  recordLoginFailure,
  resetLoginFailures,
} from '~/lib/features/auth/server/login-rate-limit.server.ts';

test('bounds concurrent login request admission without leaking slots', () => {
  const releases = Array.from({ length: loginRateLimit.MAX_CONCURRENT_LOGIN_REQUESTS }, () => acquireLoginAdmission());
  try {
    assert.equal(releases.every(Boolean), true);
    assert.equal(acquireLoginAdmission(), undefined);

    releases[0]?.();
    releases[0]?.();
    const replacement = acquireLoginAdmission();
    assert.equal(typeof replacement, 'function');
    replacement?.();
  } finally {
    for (const release of releases) release?.();
  }
});

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

test('uses the higher shared-account threshold for global credential failures', () => {
  const key = `global-test-${Math.random()}`;
  const now = 2_000_000;
  try {
    for (let index = 0; index < loginRateLimit.GLOBAL_MAX_FAILURES - 1; index += 1) {
      assert.equal(recordLoginFailure(key, now + index, loginRateLimit.GLOBAL_MAX_FAILURES), 0);
    }
    assert.ok(
      recordLoginFailure(key, now + loginRateLimit.GLOBAL_MAX_FAILURES, loginRateLimit.GLOBAL_MAX_FAILURES) > 0
    );
  } finally {
    resetLoginFailures(key);
  }
});
