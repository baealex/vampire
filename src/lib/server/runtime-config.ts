import { delimiter, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { IncomingHttpHeaders } from 'node:http';
import { isIP } from 'node:net';
import { vampireStateDirectory } from './state-path.ts';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const INTERNAL_PROTOCOL_HEADER = 'x-vampire-internal-protocol';
const TOKEN_CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;
export const MINIMUM_TOKEN_CHARACTERS = 12;
export const MAXIMUM_TOKEN_BYTES = 4 * 1024;

export interface RuntimeConfig {
  host: string;
  port: number;
  publicOrigin?: string;
  stateDirectory: string;
  tokenConfigured: boolean;
  unauthenticatedAccess: boolean;
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
  const token = env.VAMPIRE_TOKEN;
  return token && token.trim().length > 0 ? token : undefined;
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

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid VAMPIRE_PORT: ${portValue}`);
  }
  if (!token && !allowInsecureNoAuth) {
    throw new Error(
      'Refusing to start without VAMPIRE_TOKEN. For an isolated local runtime only, set VAMPIRE_ALLOW_INSECURE_NO_AUTH=1 or pass --allow-insecure-no-auth to the CLI.'
    );
  }
  if (token && [...token].length < MINIMUM_TOKEN_CHARACTERS) {
    throw new Error(`VAMPIRE_TOKEN must contain at least ${MINIMUM_TOKEN_CHARACTERS} characters.`);
  }
  if (token && Buffer.byteLength(token, 'utf8') > MAXIMUM_TOKEN_BYTES) {
    throw new Error(`VAMPIRE_TOKEN must not exceed ${MAXIMUM_TOKEN_BYTES} UTF-8 bytes.`);
  }
  if (token && TOKEN_CONTROL_CHARACTER_PATTERN.test(token)) {
    throw new Error('VAMPIRE_TOKEN must not contain control characters such as tabs or line breaks.');
  }

  return {
    host,
    port,
    publicOrigin: configuredPublicOrigin(env),
    stateDirectory: vampireStateDirectory(env),
    tokenConfigured: Boolean(token),
    unauthenticatedAccess: !token,
    workspaceRoots: parseWorkspaceRootPaths(env.VAMPIRE_WORKSPACE_ROOTS),
  };
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizedHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(normalizedHostname(hostname));
}

export function requestHostAllowed(headers: IncomingHttpHeaders, env: NodeJS.ProcessEnv = process.env): boolean {
  const host = headerValue(headers, environmentValue(env, 'VAMPIRE_ADAPTER_HOST_HEADER')?.toLowerCase() || 'host');
  if (!host || /[\s/\\?#@]/u.test(host)) return false;

  const publicOrigin = configuredPublicOrigin(env);
  let requestUrl: URL;
  try {
    const protocol = publicOrigin ? new URL(publicOrigin).protocol : 'http:';
    requestUrl = new URL(`${protocol}//${host}`);
  } catch {
    return false;
  }

  if (publicOrigin) return requestUrl.host.toLowerCase() === new URL(publicOrigin).host.toLowerCase();

  const requestHostname = normalizedHostname(requestUrl.hostname);
  const configuredHost = normalizedHostname(environmentValue(env, 'VAMPIRE_HOST') || '127.0.0.1');
  if (isLoopbackHost(configuredHost)) return isLoopbackHost(requestHostname);
  if (configuredHost === '0.0.0.0' || configuredHost === '::') {
    return requestHostname === 'localhost' || isIP(requestHostname) !== 0;
  }
  return requestHostname === configuredHost;
}

export function expectedRequestOrigin(
  headers: IncomingHttpHeaders,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  if (!requestHostAllowed(headers, env)) return undefined;
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
