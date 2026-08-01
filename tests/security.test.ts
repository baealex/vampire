import assert from 'node:assert/strict';
import test from 'node:test';
import {
	createSessionCookie,
	isSessionCookieValid,
	parseCookie,
	sessionCookieExpiresAt
} from '../src/lib/server/session-cookie.ts';
import {
	loginRateLimit,
	loginRetryAfter,
	recordLoginFailure,
	resetLoginFailures
} from '../src/lib/server/login-rate-limit.ts';

test('creates signed expiring session cookies', () => {
	const token = 'a-long-random-test-token';
	const session = createSessionCookie(token);
	assert.equal(isSessionCookieValid(session.value, token), true);
	assert.equal(isSessionCookieValid(session.value, `${token}-wrong`), false);
	assert.ok((sessionCookieExpiresAt(session.value, token) ?? 0) > Date.now());
});

test('ignores malformed percent escapes in cookie headers', () => {
	assert.deepEqual(parseCookie('good=value; broken=%E0%A4%A'), { good: 'value' });
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
