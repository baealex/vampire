const WINDOW_MS = 5 * 60 * 1_000;
const MAX_FAILURES = 5;
const BASE_BLOCK_MS = 30 * 1_000;
const MAX_BLOCK_MS = 15 * 60 * 1_000;
const MAX_TRACKED_CLIENTS = 1_000;

/** @typedef {{ failures: number[]; blockedUntil: number }} LoginEntry */
/** @type {Map<string, LoginEntry>} */
const clients = new Map();

/** @param {LoginEntry} entry @param {number} now */
function recentFailures(entry, now) {
	entry.failures = entry.failures.filter((timestamp) => timestamp > now - WINDOW_MS);
	return entry.failures;
}

/** @param {number} now */
function prune(now) {
	for (const [key, entry] of clients) {
		if (entry.blockedUntil <= now && recentFailures(entry, now).length === 0) clients.delete(key);
	}

	while (clients.size >= MAX_TRACKED_CLIENTS) {
		const oldest = clients.keys().next().value;
		if (oldest === undefined) break;
		clients.delete(oldest);
	}
}

/** @param {string} key @param {number} [now] */
export function loginRetryAfter(key, now = Date.now()) {
	const entry = clients.get(key);
	if (!entry) return 0;
	recentFailures(entry, now);
	return Math.max(0, Math.ceil((entry.blockedUntil - now) / 1_000));
}

/** @param {string} key @param {number} [now] */
export function recordLoginFailure(key, now = Date.now()) {
	prune(now);
	const entry = clients.get(key) ?? { failures: [], blockedUntil: 0 };
	recentFailures(entry, now).push(now);
	if (entry.failures.length >= MAX_FAILURES) {
		const exponent = Math.min(entry.failures.length - MAX_FAILURES, 5);
		entry.blockedUntil = now + Math.min(MAX_BLOCK_MS, BASE_BLOCK_MS * 2 ** exponent);
	}
	clients.delete(key);
	clients.set(key, entry);
	return loginRetryAfter(key, now);
}

/** @param {string} key */
export function resetLoginFailures(key) {
	clients.delete(key);
}

export const loginRateLimit = { WINDOW_MS, MAX_FAILURES, BASE_BLOCK_MS, MAX_BLOCK_MS };
