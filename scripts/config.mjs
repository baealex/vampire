import { delimiter, join, resolve } from 'node:path';
import { homedir } from 'node:os';

const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * @param {string | undefined} value
 * @param {string} [baseDirectory]
 * @param {string} [homeDirectory]
 */
export function parseWorkspaceRootPaths(value, baseDirectory = process.cwd(), homeDirectory = homedir()) {
	const configuredPaths = typeof value === 'string' && value.trim().length > 0
		? value.split(delimiter).map((path) => path.trim()).filter(Boolean)
		: [baseDirectory];
	const resolvedPaths = configuredPaths.map((path) => {
		const expandedPath = path === '~'
			? homeDirectory
			: path.startsWith('~/') || path.startsWith('~\\')
				? join(homeDirectory, path.slice(2))
				: path;
		return resolve(baseDirectory, expandedPath);
	});

	return [...new Set(resolvedPaths)];
}

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

	return {
		host,
		port,
		tokenConfigured: Boolean(token),
		workspaceRoots: parseWorkspaceRootPaths(env.VAMPIRE_WORKSPACE_ROOTS)
	};
}
