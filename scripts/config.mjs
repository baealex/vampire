const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1']);

export function runtimeConfig(env = process.env) {
	const host = env.VAMPIRE_HOST || '127.0.0.1';
	const portValue = env.VAMPIRE_PORT || '7677';
	const port = Number(portValue);
	const token = env.VAMPIRE_TOKEN?.trim() || undefined;

	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error(`Invalid VAMPIRE_PORT: ${portValue}`);
	}
	if (!loopbackHosts.has(host) && !token) {
		throw new Error('Refusing a non-loopback bind without VAMPIRE_TOKEN. Use a private network or TLS reverse proxy.');
	}

	return { host, port, tokenConfigured: Boolean(token) };
}
