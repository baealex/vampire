import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { type IncomingHttpHeaders, request as requestHttp } from 'node:http';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const packageSource = process.argv[2];
const expectedVersionArgument = process.argv[3];
const upgradeFrom = process.argv[4];

if (!packageSource) {
  console.error(
    'Usage: node tools/package-smoke.ts <package.tgz|package-directory|package-spec> [expected-version] [upgrade-from-package-spec]',
  );
  process.exit(1);
}

const temporaryDirectory = await realpath(await mkdtemp(join(tmpdir(), 'vampire-package-smoke-')));
const installDirectory = join(temporaryDirectory, 'install');
const workspaceDirectory = join(temporaryDirectory, 'workspace');
const stateDirectory = join(temporaryDirectory, 'state');
const tokenFile = join(temporaryDirectory, 'token');
const resolvedPackageSource = await resolvePackageSource(packageSource);
const expectedVersion = expectedVersionArgument || (await packageVersionFromRepository());
const smokeToken = 'vampire-package-smoke-token';
const smokeTmuxSocket = `vampire-package-smoke-${process.pid}`;

try {
  await mkdir(workspaceDirectory, { recursive: true });
  await writeFile(tokenFile, `${smokeToken}\n`, { mode: 0o600 });
  await installPackage(resolvedPackageSource, installDirectory);

  const installedPackageDirectory = join(installDirectory, 'node_modules', 'vampire');
  const manifest = JSON.parse(await readFile(join(installedPackageDirectory, 'package.json'), 'utf8')) as {
    version?: string;
  };
  if (manifest.version !== expectedVersion) {
    throw new Error(`Installed vampire@${manifest.version}; expected vampire@${expectedVersion}.`);
  }

  if (upgradeFrom) {
    const previousInstall = join(temporaryDirectory, 'previous-install');
    await installPackage(upgradeFrom, previousInstall);
    let savedWorkspaceId = '';
    const expectedReads = new Map<string, unknown>();
    const readJson = async (base: string, path: string, method = 'GET', data?: unknown) => {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { origin: base, 'content-type': 'application/json' },
        body: data === undefined ? undefined : JSON.stringify(data),
      });
      if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
      return response.json();
    };
    await verifyInstalledServer(
      join(previousInstall, 'node_modules', 'vampire'),
      workspaceDirectory,
      stateDirectory,
      undefined,
      undefined,
      undefined,
      async (base) => {
        const created = await readJson(base, '/api/workspaces', 'POST', { cwd: workspaceDirectory });
        savedWorkspaceId = created.workspace.id;
        await readJson(base, `/api/workspaces/${savedWorkspaceId}/note`, 'PUT', {
          note: 'Preserve this note during upgrade.\n한글 메모',
        });
        await readJson(base, `/api/workspaces/${savedWorkspaceId}/composer-prompts`, 'POST', {
          prompt: 'Preserve composer history',
        });
        await readJson(base, '/api/launch-profiles', 'PUT', {
          launchProfiles: [{ id: 'upgrade-profile', name: 'Upgrade profile', command: 'printf upgrade' }],
        });
        await readJson(base, '/api/workspace-preferences', 'PUT', {
          workspaceOrderMode: 'manual',
          manualWorkspaceOrder: [savedWorkspaceId],
        });
        for (const path of [
          `/api/workspaces/${savedWorkspaceId}/note`,
          `/api/workspaces/${savedWorkspaceId}/composer-prompts`,
          '/api/launch-profiles',
          '/api/workspace-preferences',
        ]) {
          expectedReads.set(path, await readJson(base, path));
        }
      },
    );
    await verifyInstalledServer(
      installedPackageDirectory,
      workspaceDirectory,
      stateDirectory,
      undefined,
      undefined,
      undefined,
      async (base) => {
        const restored = await readJson(base, '/api/workspaces');
        assert.ok(
          restored.workspaces.some(
            (workspace: { id: string; cwd: string }) =>
              workspace.id === savedWorkspaceId && workspace.cwd === workspaceDirectory,
          ),
          'The upgraded server must restore the existing workspace',
        );
        for (const [path, expected] of expectedReads)
          assert.deepEqual(await readJson(base, path), expected, `Upgrade changed ${path}`);
      },
    );
    console.log(`Verified upgrade from ${upgradeFrom} to vampire@${expectedVersion}.`);
  }

  await verifyInstalledServer(
    installedPackageDirectory,
    workspaceDirectory,
    stateDirectory,
    undefined,
    undefined,
    undefined,
    verifyLocalAccess,
  );
  await verifyInstalledServer(
    installedPackageDirectory,
    workspaceDirectory,
    stateDirectory,
    smokeToken,
    tokenFile,
    undefined,
    verifyAuthentication,
  );
  await verifyInstalledServer(
    installedPackageDirectory,
    workspaceDirectory,
    stateDirectory,
    smokeToken,
    tokenFile,
    'https://vampire.example.com:8443',
    verifyPublicOrigin,
  );

  console.log(`Verified installed vampire@${expectedVersion} from ${packageSource}.`);
} finally {
  if (upgradeFrom) await execFileAsync('tmux', ['-L', smokeTmuxSocket, 'kill-server']).catch(() => undefined);
  await rm(temporaryDirectory, { recursive: true, force: true });
}

async function verifyInstalledServer(
  installedPackageDirectory: string,
  workspaceDirectory: string,
  stateDirectory: string,
  token: string | undefined,
  tokenFile: string | undefined,
  publicOrigin: string | undefined,
  verify: (baseUrl: string, token?: string, publicOrigin?: string) => Promise<void>,
): Promise<void> {
  const port = await availablePort();
  const options = [
    join(installedPackageDirectory, 'bin', 'vampire.js'),
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--state-dir',
    stateDirectory,
    '--workspace-root',
    workspaceDirectory,
  ];
  if (tokenFile) options.push('--token-file', tokenFile);
  if (publicOrigin) options.push('--origin', publicOrigin);
  const child = spawn(process.execPath, options, {
    cwd: workspaceDirectory,
    env: runtimeEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForHttpServer(child, `${baseUrl}/`, () => output, publicOrigin);
    await verify(baseUrl, token, publicOrigin);
  } finally {
    await stopProcess(child);
  }
}

async function installPackage(source: string, directory: string): Promise<void> {
  const attempts = source.endsWith('.tgz') ? 1 : 60;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });
    try {
      await execFileAsync(
        npmCommand(),
        ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', '--prefix', directory, source],
        { timeout: 120_000 },
      );
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await delay(5_000);
    }
  }

  throw lastError;
}

function npmCommand(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

async function resolvePackageSource(source: string): Promise<string> {
  if (source.endsWith('.tgz')) return resolve(source);

  const candidate = resolve(source);
  try {
    if (!(await stat(candidate)).isDirectory()) return source;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return source;
  }

  const packageFiles = (await readdir(candidate)).filter((file) => /^vampire-.*\.tgz$/.test(file));
  if (packageFiles.length !== 1) {
    throw new Error(`Expected one Vampire package artifact in ${source}, found ${packageFiles.length}.`);
  }
  return join(candidate, packageFiles[0]);
}

async function packageVersionFromRepository(): Promise<string> {
  const packageJson = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as { version?: string };
  if (!packageJson.version) throw new Error('package.json does not define a version.');
  return packageJson.version;
}

async function availablePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
  if (!address || typeof address === 'string') throw new Error('Could not reserve a smoke-test port.');
  return address.port;
}

function runtimeEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  environment.VAMPIRE_TMUX_SOCKET_NAME = smokeTmuxSocket;
  delete environment.VAMPIRE_SAFE_DEVELOPMENT;
  delete environment.VAMPIRE_CLIENT_DIR;
  delete environment.VAMPIRE_BUILD_DIR;
  delete environment.VAMPIRE_TOKEN;
  delete environment.VAMPIRE_PUBLIC_ORIGIN;
  delete environment.VAMPIRE_ADAPTER_ORIGIN;
  delete environment.VAMPIRE_ADAPTER_PROTOCOL_HEADER;
  delete environment.VAMPIRE_ADAPTER_HOST_HEADER;
  delete environment.VAMPIRE_ADAPTER_PORT_HEADER;
  delete environment.VAMPIRE_ALLOW_INSECURE_NO_AUTH;
  return environment;
}

async function verifyLocalAccess(baseUrl: string): Promise<void> {
  const html = await (await fetch(baseUrl)).text();
  const script = /<script\b[^>]*\bsrc="([^"]+\.js)"/.exec(html)?.[1];
  assert.ok(script, 'The installed client must reference its built entry script');
  const assetUrl = new URL(script, baseUrl);
  assert.equal(assetUrl.origin, baseUrl);
  const compressed = await fetch(assetUrl, { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(compressed.status, 200);
  assert.equal(compressed.headers.get('content-encoding'), 'gzip');
  const identity = await fetch(assetUrl, { headers: { 'accept-encoding': 'identity' } });
  assert.equal(identity.status, 200);
  assert.equal(await compressed.text(), await identity.text(), 'Compression must preserve the client script');
  const status = await fetch(`${baseUrl}/api/status`);
  if (!status.ok) throw new Error(`Packaged CLI rejected local status access with status ${status.status}.`);
  const body = (await status.json()) as { authenticated?: boolean; authenticationRequired?: boolean };
  if (body.authenticationRequired !== false || body.authenticated !== true) {
    throw new Error('Packaged CLI unexpectedly required authentication for loopback access.');
  }

  const workspaces = await fetch(`${baseUrl}/api/workspaces`);
  if (!workspaces.ok) {
    throw new Error(`Packaged CLI rejected unauthenticated loopback access with status ${workspaces.status}.`);
  }
  await expectStreamStatus(baseUrl, '/events/workspaces', 200);
}

async function verifyAuthentication(baseUrl: string, token?: string): Promise<void> {
  if (!token) throw new Error('A TOKEN is required for the authentication smoke test.');
  const wrongHost = await rawHttpRequest(`${baseUrl}/api/status`, { headers: { host: 'attacker.example' } });
  if (wrongHost.status !== 421) {
    throw new Error(`Packaged CLI accepted an unexpected Host header with status ${wrongHost.status}.`);
  }

  await expectStreamStatus(baseUrl, '/events/workspaces', 401, { Authorization: `Bearer ${token}` });
  await expectUpgradeStatus(baseUrl, '/ws/unsupported', 404);

  const bearerOnly = await fetch(`${baseUrl}/api/workspaces`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (bearerOnly.status !== 401) {
    throw new Error(`Packaged CLI accepted the login TOKEN as a bearer credential with status ${bearerOnly.status}.`);
  }

  const login = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // Direct clients must not be able to opt themselves into HTTPS semantics.
      'x-forwarded-proto': 'https',
    },
    body: JSON.stringify({ token }),
  });
  if (!login.ok) throw new Error(`Packaged CLI rejected its configured access token with status ${login.status}.`);

  const setCookie = login.headers.getSetCookie().find((value) => value.startsWith('vampire_session='));
  if (!setCookie) throw new Error('Packaged CLI did not create an HTTP authentication cookie.');
  if (/(?:^|;\s*)Secure(?:;|$)/i.test(setCookie)) {
    throw new Error('Packaged CLI marked its direct HTTP authentication cookie as Secure.');
  }

  const cookie = setCookie.split(';', 1)[0];
  const workspaces = await fetch(`${baseUrl}/api/workspaces`, { headers: { cookie } });
  if (!workspaces.ok) {
    throw new Error(`Packaged CLI did not accept its authentication cookie; status ${workspaces.status}.`);
  }
  await expectStreamStatus(baseUrl, '/events/workspaces', 200, { Cookie: cookie });

  const logout = await fetch(`${baseUrl}/api/login`, { method: 'DELETE', headers: { cookie } });
  if (!logout.ok) throw new Error(`Packaged CLI could not revoke its authentication session; status ${logout.status}.`);
  const revoked = await fetch(`${baseUrl}/api/workspaces`, { headers: { cookie } });
  if (revoked.status !== 401) {
    throw new Error(`Packaged CLI accepted a revoked authentication session with status ${revoked.status}.`);
  }
}

async function expectUpgradeStatus(
  baseUrl: string,
  path: string,
  expectedStatus: number,
  headers: Record<string, string> = {},
): Promise<void> {
  const url = new URL(baseUrl);
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const socket = connect({ host: url.hostname, port: Number(url.port) });
    let response = '';
    let settled = false;
    const timeout = setTimeout(() => {
      socket.destroy();
      rejectPromise(new Error(`Timed out waiting for the packaged CLI to reject WebSocket upgrade ${path}.`));
    }, 3_000);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error) rejectPromise(error);
      else resolvePromise();
    };

    socket.setEncoding('utf8');
    socket.on('connect', () => {
      const requestHeaders = {
        Host: url.host,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        ...headers,
      };
      const lines = [
        `GET ${path} HTTP/1.1`,
        ...Object.entries(requestHeaders).map(([name, value]) => `${name}: ${value}`),
      ];
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    });
    socket.on('data', (chunk: string) => {
      response += chunk;
      const actualStatus = Number(/^HTTP\/1\.1 (\d{3})/u.exec(response)?.[1]);
      if (actualStatus === expectedStatus && response.includes('\r\n\r\n')) finish();
    });
    socket.once('error', (error) => {
      const actualStatus = Number(/^HTTP\/1\.1 (\d{3})/u.exec(response)?.[1]);
      finish(actualStatus === expectedStatus ? undefined : error);
    });
    socket.once('close', () => {
      const actualStatus = Number(/^HTTP\/1\.1 (\d{3})/u.exec(response)?.[1]);
      finish(
        actualStatus === expectedStatus
          ? undefined
          : new Error(`WebSocket upgrade ${path} returned ${actualStatus || 'no status'}; expected ${expectedStatus}.`),
      );
    });
  });
}

async function expectStreamStatus(
  baseUrl: string,
  path: string,
  expectedStatus: number,
  headers: Record<string, string> = {},
): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const request = requestHttp(
      `${baseUrl}${path}`,
      { headers: { Accept: 'text/event-stream', ...headers } },
      (response) => {
        const status = response.statusCode ?? 0;
        response.destroy();
        if (status === expectedStatus) resolvePromise();
        else rejectPromise(new Error(`Event stream ${path} returned ${status}; expected ${expectedStatus}.`));
      },
    );
    request.setTimeout(3_000, () => request.destroy(new Error(`Event stream timed out: ${path}`)));
    request.once('error', rejectPromise);
    request.end();
  });
}

async function verifyPublicOrigin(baseUrl: string, token?: string, publicOrigin?: string): Promise<void> {
  if (!token) throw new Error('A TOKEN is required for the reverse-proxy smoke test.');
  if (!publicOrigin) throw new Error('A public origin is required for the reverse-proxy smoke test.');
  const publicHost = new URL(publicOrigin).host;
  const body = JSON.stringify({ token });

  const rejected = await rawHttpRequest(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: publicHost, origin: baseUrl },
    body,
  });
  if (rejected.status !== 403) {
    throw new Error(`Packaged CLI accepted a login from the wrong origin with status ${rejected.status}.`);
  }

  const login = await rawHttpRequest(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: publicHost, origin: publicOrigin },
    body,
  });
  if (login.status < 200 || login.status >= 300) {
    throw new Error(`Packaged CLI rejected its public origin with status ${login.status}.`);
  }
  const setCookieHeader = login.headers['set-cookie'];
  const setCookie = (Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader]).find((value) =>
    /^__Host-vampire_session=[^;]/u.test(value ?? ''),
  );
  if (!setCookie || !/(?:^|;\s*)Secure(?:;|$)/i.test(setCookie)) {
    throw new Error('Packaged CLI did not mark its public HTTPS authentication cookie as Secure.');
  }

  const cookie = setCookie.split(';', 1)[0];
  const workspaces = await rawHttpRequest(`${baseUrl}/api/workspaces`, {
    headers: { host: publicHost, cookie },
  });
  if (workspaces.status !== 200) {
    throw new Error(`Packaged CLI did not accept its public-origin session; status ${workspaces.status}.`);
  }

  await expectStreamStatus(baseUrl, '/events/workspaces', 200, {
    Host: publicHost,
    Cookie: cookie,
  });
}

async function waitForHttpServer(
  child: ChildProcess,
  url: string,
  output: () => string,
  publicOrigin?: string,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Packaged CLI exited with code ${child.exitCode}.\n${output()}`);
    }
    try {
      const response = publicOrigin
        ? await rawHttpRequest(url, {
            headers: { host: new URL(publicOrigin).host },
            timeout: 1_000,
          })
        : await fetch(url, { signal: AbortSignal.timeout(1_000) });
      const status = response.status;
      if (status >= 200 && status < 300) return;
    } catch {
      // The server may still be starting.
    }
    await delay(100);
  }
  throw new Error(`Packaged CLI did not serve HTTP within 20 seconds.\n${output()}`);
}

interface RawHttpResponse {
  body: string;
  headers: IncomingHttpHeaders;
  status: number;
}

function rawHttpRequest(
  url: string,
  options: {
    body?: string;
    headers?: Record<string, string>;
    method?: string;
    timeout?: number;
  } = {},
): Promise<RawHttpResponse> {
  return new Promise((resolvePromise, rejectPromise) => {
    const request = requestHttp(
      url,
      {
        method: options.method ?? 'GET',
        headers: options.headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.once('end', () => {
          resolvePromise({
            body: Buffer.concat(chunks).toString('utf8'),
            headers: response.headers,
            status: response.statusCode ?? 0,
          });
        });
      },
    );
    request.setTimeout(options.timeout ?? 3_000, () => request.destroy(new Error(`HTTP request timed out: ${url}`)));
    request.once('error', rejectPromise);
    request.end(options.body);
  });
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolveExit) => {
    const timeout = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
      resolveExit();
    }, 5_000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolveExit();
    });
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
