import assert from 'node:assert/strict';
import { delimiter, join, resolve } from 'node:path';
import test from 'node:test';
import {
  applyVampireEnvironmentDefaults,
  configureAdapterRequestOrigin,
  configuredPublicOrigin,
  configuredToken,
  expectedRequestOrigin,
  isLoopbackHost,
  listeningUrl,
  MAXIMUM_TOKEN_BYTES,
  parseWorkspaceRootPaths,
  requestHostAllowed,
  runtimeConfig,
} from '~/lib/server/runtime-config.ts';

test('defaults workspace browsing to the server launch directory', () => {
  assert.deepEqual(parseWorkspaceRootPaths(undefined, '/tmp/vampire-project', '/tmp/home'), ['/tmp/vampire-project']);
});

test('parses, expands, resolves, and deduplicates configured workspace roots', () => {
  const baseDirectory = '/tmp/vampire-project';
  const homeDirectory = '/tmp/home';
  const configured = ['~/Code', join(baseDirectory, 'Projects'), join(homeDirectory, 'Code'), './Projects'].join(
    delimiter
  );

  assert.deepEqual(parseWorkspaceRootPaths(configured, baseDirectory, homeDirectory), [
    '/tmp/home/Code',
    '/tmp/vampire-project/Projects',
  ]);
});

test('includes parsed workspace roots in runtime configuration', () => {
  const config = runtimeConfig({
    VAMPIRE_HOST: '127.0.0.1',
    VAMPIRE_PORT: '7677',
    VAMPIRE_WORKSPACE_ROOTS: '/tmp/one:/tmp/two',
    VAMPIRE_TOKEN: 'workspace password',
  });

  assert.deepEqual(config.workspaceRoots, [resolve('/tmp/one'), resolve('/tmp/two')]);
});

test('allows unauthenticated loopback access by default and enables authentication when configured', () => {
  const localConfig = runtimeConfig({ VAMPIRE_HOST: '127.0.0.1' });
  assert.equal(localConfig.externalAccess, false);
  assert.equal(localConfig.tokenConfigured, false);
  assert.equal(localConfig.unauthenticatedAccess, true);

  const authenticatedLocalConfig = runtimeConfig({
    VAMPIRE_HOST: 'localhost',
    VAMPIRE_TOKEN: 'workspace password',
  });
  assert.equal(authenticatedLocalConfig.externalAccess, false);
  assert.equal(authenticatedLocalConfig.tokenConfigured, true);
  assert.equal(authenticatedLocalConfig.unauthenticatedAccess, false);
});

test('requires TOKEN authentication for external binds and public origins', () => {
  assert.throws(() => runtimeConfig({ VAMPIRE_HOST: '0.0.0.0' }), /external access without VAMPIRE_TOKEN/);
  assert.throws(
    () =>
      runtimeConfig({
        VAMPIRE_HOST: '127.0.0.1',
        VAMPIRE_PUBLIC_ORIGIN: 'https://vampire.example.com',
      }),
    /external access without VAMPIRE_TOKEN/
  );

  const directConfig = runtimeConfig({
    VAMPIRE_HOST: '0.0.0.0',
    VAMPIRE_TOKEN: 'workspace password',
  });
  assert.equal(directConfig.externalAccess, true);
  assert.equal(directConfig.tokenConfigured, true);

  const proxiedConfig = runtimeConfig({
    VAMPIRE_HOST: '127.0.0.1',
    VAMPIRE_PUBLIC_ORIGIN: 'https://vampire.example.com',
    VAMPIRE_TOKEN: 'workspace password',
  });
  assert.equal(proxiedConfig.externalAccess, true);
  assert.equal(proxiedConfig.tokenConfigured, true);
});

test('validates every configured TOKEN', () => {
  assert.throws(() => runtimeConfig({ VAMPIRE_TOKEN: 'too-short' }), /at least 12 characters/);
  assert.throws(() => runtimeConfig({ VAMPIRE_TOKEN: 'x'.repeat(MAXIMUM_TOKEN_BYTES + 1) }), /must not exceed/);
  assert.throws(() => runtimeConfig({ VAMPIRE_TOKEN: 'password with\nnewline' }), /control characters/);
});

test('allows an explicit insecure override for an unauthenticated external bind', () => {
  const config = runtimeConfig({
    VAMPIRE_HOST: '0.0.0.0',
    VAMPIRE_ALLOW_INSECURE_NO_AUTH: '1',
  });
  assert.equal(config.externalAccess, true);
  assert.equal(config.tokenConfigured, false);
  assert.equal(config.unauthenticatedAccess, true);
});

test('identifies only explicit loopback hosts for development binds', () => {
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('[::1]'), true);
  assert.equal(isLoopbackHost('0.0.0.0'), false);
  assert.equal(isLoopbackHost('::'), false);
  assert.equal(isLoopbackHost('development.example.com'), false);
});

test('validates and shares one public origin across runtime consumers', () => {
  assert.equal(
    configuredPublicOrigin({ VAMPIRE_PUBLIC_ORIGIN: 'https://vampire.example.com' }),
    'https://vampire.example.com'
  );
  assert.equal(
    configuredPublicOrigin({ VAMPIRE_ADAPTER_ORIGIN: 'https://legacy.example.com/' }),
    'https://legacy.example.com'
  );
  assert.throws(
    () => configuredPublicOrigin({ VAMPIRE_PUBLIC_ORIGIN: 'https://vampire.example.com/path' }),
    /without a path/
  );
  assert.throws(
    () =>
      configuredPublicOrigin({
        VAMPIRE_PUBLIC_ORIGIN: 'https://one.example.com',
        VAMPIRE_ADAPTER_ORIGIN: 'https://two.example.com',
      }),
    /must describe the same origin/
  );
});

test('uses an internal overwritten protocol header for direct HTTP', () => {
  const env: NodeJS.ProcessEnv = {};
  const config = runtimeConfig(env);
  const policy = configureAdapterRequestOrigin(config, env);

  assert.equal(policy.injectedProtocolHeader, 'x-vampire-internal-protocol');
  assert.equal(env.VAMPIRE_ADAPTER_PROTOCOL_HEADER, 'x-vampire-internal-protocol');
  assert.equal(
    expectedRequestOrigin(
      { host: 'localhost:7677', 'x-vampire-internal-protocol': 'http', 'x-forwarded-proto': 'https' },
      env
    ),
    'http://localhost:7677'
  );
});

test('uses a fixed public origin instead of forwarded request headers', () => {
  const env: NodeJS.ProcessEnv = {
    VAMPIRE_PUBLIC_ORIGIN: 'https://vampire.example.com',
    VAMPIRE_TOKEN: 'workspace password',
  };
  const config = runtimeConfig(env);
  const policy = configureAdapterRequestOrigin(config, env);

  assert.deepEqual(policy, {});
  assert.equal(env.VAMPIRE_ADAPTER_ORIGIN, 'https://vampire.example.com');
  assert.equal(
    expectedRequestOrigin({ host: 'vampire.example.com', 'x-forwarded-proto': 'http' }, env),
    'https://vampire.example.com'
  );
});

test('rejects unconfigured hostnames that can be used for DNS rebinding', () => {
  assert.equal(requestHostAllowed({ host: 'localhost:7677' }, { VAMPIRE_HOST: '127.0.0.1' }), true);
  assert.equal(requestHostAllowed({ host: '127.0.0.1:7677' }, { VAMPIRE_HOST: '127.0.0.1' }), true);
  assert.equal(requestHostAllowed({ host: 'attacker.example:7677' }, { VAMPIRE_HOST: '127.0.0.1' }), false);
  assert.equal(requestHostAllowed({ host: 'attacker@127.0.0.1:7677' }, { VAMPIRE_HOST: '127.0.0.1' }), false);
  assert.equal(requestHostAllowed({ host: '127.0.0.1:7677/path' }, { VAMPIRE_HOST: '127.0.0.1' }), false);
  assert.equal(
    requestHostAllowed({ host: 'vampire.example.com' }, { VAMPIRE_PUBLIC_ORIGIN: 'https://vampire.example.com' }),
    true
  );
});

test('loads development env files as defaults without overriding the shell', () => {
  const env: NodeJS.ProcessEnv = { VAMPIRE_PORT: '9000' };
  applyVampireEnvironmentDefaults(
    { VAMPIRE_PORT: '8000', VAMPIRE_TOKEN: 'file-token', UNRELATED_SECRET: 'ignored' },
    env
  );

  assert.equal(env.VAMPIRE_PORT, '9000');
  assert.equal(configuredToken(env), 'file-token');
  assert.equal(env.UNRELATED_SECRET, undefined);
});

test('formats usable wildcard and IPv6 listening URLs', () => {
  assert.equal(listeningUrl({ host: '0.0.0.0', port: 7677 }), 'http://localhost:7677');
  assert.equal(listeningUrl({ host: '::1', port: 7677 }), 'http://[::1]:7677');
});
