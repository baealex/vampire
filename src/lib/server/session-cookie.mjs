import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const SESSION_TTL_SECONDS = 24 * 60 * 60;

/** @param {string} token @param {string} payload */
function signature(token, payload) {
	return createHmac('sha256', token).update(payload).digest('base64url');
}

/** @param {string} left @param {string} right */
function equal(left, right) {
	const leftHash = createHmac('sha256', 'vampire-compare').update(left).digest();
	const rightHash = createHmac('sha256', 'vampire-compare').update(right).digest();
	return timingSafeEqual(leftHash, rightHash);
}

/** @param {string} token */
export function createSessionCookie(token) {
	const expiresAt = Math.floor(Date.now() / 1_000) + SESSION_TTL_SECONDS;
	const payload = `${expiresAt}.${randomBytes(18).toString('base64url')}`;
	return { value: `${payload}.${signature(token, payload)}`, maxAge: SESSION_TTL_SECONDS };
}

/** @param {string | undefined} value @param {string | undefined} token */
export function isSessionCookieValid(value, token) {
	if (!value || !token) return false;
	const separator = value.lastIndexOf('.');
	if (separator < 1) return false;
	const payload = value.slice(0, separator);
	const suppliedSignature = value.slice(separator + 1);
	const [expiresAt] = payload.split('.');
	if (!/^\d+$/.test(expiresAt) || Number(expiresAt) <= Math.floor(Date.now() / 1_000)) return false;
	return equal(suppliedSignature, signature(token, payload));
}

/** @param {string | undefined} value @param {string | undefined} token */
export function sessionCookieExpiresAt(value, token) {
	if (!value || !token || !isSessionCookieValid(value, token)) return undefined;
	const expiresAt = Number(value.slice(0, value.indexOf('.')));
	return Number.isFinite(expiresAt) ? expiresAt * 1_000 : undefined;
}

/** @param {{ authorization?: string; sessionCookie?: string; token?: string }} request */
export function isAuthorized({ authorization, sessionCookie, token }) {
	if (!token) return true;
	if (authorization?.startsWith('Bearer ') && equal(authorization.slice(7), token)) return true;
	return isSessionCookieValid(sessionCookie, token);
}

/** @param {string | undefined} header @returns {Record<string, string>} */
export function parseCookie(header) {
	if (!header) return {};
	return Object.fromEntries(header.split(';').flatMap((part) => {
		const [key, ...value] = part.trim().split('=');
		if (!key) return [];
		try {
			return [[key, decodeURIComponent(value.join('='))]];
		} catch {
			return [];
		}
	}));
}
