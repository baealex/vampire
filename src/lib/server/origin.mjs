const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** @param {string} hostname */
function isLoopbackHost(hostname) {
	return loopbackHosts.has(hostname);
}

/** @param {string} origin @param {string} expectedOrigin */
export function originsMatch(origin, expectedOrigin) {
	if (origin === expectedOrigin) return true;

	try {
		const actual = new URL(origin);
		const expected = new URL(expectedOrigin);
		if (actual.username || actual.password || actual.pathname !== '/' || actual.search || actual.hash) return false;
		if (!['http:', 'https:'].includes(actual.protocol) || !['http:', 'https:'].includes(expected.protocol)) return false;

		return actual.protocol === expected.protocol
			&& actual.port === expected.port
			&& isLoopbackHost(actual.hostname)
			&& isLoopbackHost(expected.hostname);
	} catch {
		return false;
	}
}
