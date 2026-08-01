import { delimiter, join, resolve } from 'node:path';
import { homedir } from 'node:os';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export interface RuntimeConfig {
	host: string;
	port: number;
	tokenConfigured: boolean;
	workspaceRoots: string[];
}

export function parseWorkspaceRootPaths(
	value: string | undefined,
	baseDirectory = process.cwd(),
	homeDirectory = homedir()
): string[] {
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

export function runtimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
	const host = env.VAMPIRE_HOST || '127.0.0.1';
	const portValue = env.VAMPIRE_PORT || '7677';
	const port = Number(portValue);
	const token = env.VAMPIRE_TOKEN?.trim() || undefined;

	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error(`Invalid VAMPIRE_PORT: ${portValue}`);
	}
	if (!LOOPBACK_HOSTS.has(host) && !token) {
		throw new Error('Refusing a non-loopback bind without VAMPIRE_TOKEN. Use a private network or TLS reverse proxy.');
	}

	return {
		host,
		port,
		tokenConfigured: Boolean(token),
		workspaceRoots: parseWorkspaceRootPaths(env.VAMPIRE_WORKSPACE_ROOTS)
	};
}
