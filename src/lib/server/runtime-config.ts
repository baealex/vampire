import { delimiter, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { IncomingHttpHeaders } from 'node:http';
import { vampireStateDirectory } from './state-path.ts';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const INTERNAL_PROTOCOL_HEADER = 'x-vampire-internal-protocol';

export interface RuntimeConfig {
  host: string;
  port: number;
  publicOrigin?: string;
  stateDirectory: string;
  tokenConfigured: boolean;
  unauthenticatedRemoteAccess: boolean;
  workspaceRoots: string[];
}

export interface AdapterRequestOriginPolicy {
  injectedProtocolHeader?: string;
}

export function applyVampireEnvironmentDefaults(
  defaults: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env
): void {
  for (const [name, value] of Object.entries(defaults)) {
    if (name.startsWith('VAMPIRE_') && env[name] === undefined) env[name] = value;
  }
}

function environmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[name]?.trim() || undefined;
}

function parseOrigin(name: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid ${name}: ${value}. Expected an http:// or https:// origin.`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error(`Invalid ${name}: ${value}. Expected an http:// or https:// origin.`);
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`Invalid ${name}: ${value}. Configure an origin without a path, query, or fragment.`);
  }
  return url.origin;
}

export function configuredToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return environmentValue(env, 'VAMPIRE_TOKEN');
}

export function configuredPublicOrigin(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const publicOriginValue = environmentValue(env, 'VAMPIRE_PUBLIC_ORIGIN');
  const adapterOriginValue = environmentValue(env, 'VAMPIRE_ADAPTER_ORIGIN');
  const publicOrigin = publicOriginValue ? parseOrigin('VAMPIRE_PUBLIC_ORIGIN', publicOriginValue) : undefined;
  const adapterOrigin = adapterOriginValue ? parseOrigin('VAMPIRE_ADAPTER_ORIGIN', adapterOriginValue) : undefined;

  if (publicOrigin && adapterOrigin && publicOrigin !== adapterOrigin) {
    throw new Error('VAMPIRE_PUBLIC_ORIGIN and VAMPIRE_ADAPTER_ORIGIN must describe the same origin.');
  }
  return publicOrigin ?? adapterOrigin;
}

export function parseWorkspaceRootPaths(
  value: string | undefined,
  baseDirectory = process.cwd(),
  homeDirectory = homedir()
): string[] {
  const configuredPaths =
    typeof value === 'string' && value.trim().length > 0
      ? value
          .split(delimiter)
          .map((path) => path.trim())
          .filter(Boolean)
      : [baseDirectory];
  const resolvedPaths = configuredPaths.map((path) => {
    const expandedPath =
      path === '~'
        ? homeDirectory
        : path.startsWith('~/') || path.startsWith('~\\')
          ? join(homeDirectory, path.slice(2))
          : path;
    return resolve(baseDirectory, expandedPath);
  });

  return [...new Set(resolvedPaths)];
}

export function runtimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const host = environmentValue(env, 'VAMPIRE_HOST') || '127.0.0.1';
  const portValue = environmentValue(env, 'VAMPIRE_PORT') || '7677';
  const port = Number(portValue);
  const token = configuredToken(env);
  const allowInsecureNoAuth = env.VAMPIRE_ALLOW_INSECURE_NO_AUTH === '1';
  const nonLoopbackHost = !LOOPBACK_HOSTS.has(host.toLowerCase());

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid VAMPIRE_PORT: ${portValue}`);
  }
  if (nonLoopbackHost && !token && !allowInsecureNoAuth) {
    throw new Error('Refusing a non-loopback bind without VAMPIRE_TOKEN. Use a private network or TLS reverse proxy.');
  }

  return {
    host,
    port,
    publicOrigin: configuredPublicOrigin(env),
    stateDirectory: vampireStateDirectory(env),
    tokenConfigured: Boolean(token),
    unauthenticatedRemoteAccess: nonLoopbackHost && !token,
    workspaceRoots: parseWorkspaceRootPaths(env.VAMPIRE_WORKSPACE_ROOTS),
  };
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function expectedRequestOrigin(
  headers: IncomingHttpHeaders,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const configuredOrigin = configuredPublicOrigin(env);
  if (configuredOrigin) return configuredOrigin;

  const protocolHeader = environmentValue(env, 'VAMPIRE_ADAPTER_PROTOCOL_HEADER')?.toLowerCase();
  const hostHeader = environmentValue(env, 'VAMPIRE_ADAPTER_HOST_HEADER')?.toLowerCase() || 'host';
  const portHeader = environmentValue(env, 'VAMPIRE_ADAPTER_PORT_HEADER')?.toLowerCase();
  const protocol = protocolHeader ? headerValue(headers, protocolHeader) : 'http';
  const host = headerValue(headers, hostHeader);
  const port = portHeader ? headerValue(headers, portHeader) : undefined;
  if (!protocol || !host || !['http', 'https'].includes(protocol) || (port && !/^\d+$/.test(port))) return undefined;

  try {
    return new URL(`${protocol}://${host}${port ? `:${port}` : ''}`).origin;
  } catch {
    return undefined;
  }
}

export function configureAdapterRequestOrigin(
  config: RuntimeConfig,
  env: NodeJS.ProcessEnv = process.env
): AdapterRequestOriginPolicy {
  if (config.publicOrigin) {
    env.VAMPIRE_ADAPTER_ORIGIN = config.publicOrigin;
    return {};
  }

  if (environmentValue(env, 'VAMPIRE_ADAPTER_PROTOCOL_HEADER')) return {};

  env.VAMPIRE_ADAPTER_PROTOCOL_HEADER = INTERNAL_PROTOCOL_HEADER;
  return { injectedProtocolHeader: INTERNAL_PROTOCOL_HEADER };
}

function urlHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

export function listeningUrl(config: Pick<RuntimeConfig, 'host' | 'port'>): string {
  const displayHost = config.host === '0.0.0.0' ? 'localhost' : config.host === '::' ? '::1' : config.host;
  return `http://${urlHost(displayHost)}:${config.port}`;
}
