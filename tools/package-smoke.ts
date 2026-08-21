import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const packageSource = process.argv[2];
const expectedVersion = process.argv[3];

if (!packageSource || !expectedVersion) {
  console.error('Usage: node tools/package-smoke.ts <package.tgz|package-spec> <expected-version>');
  process.exit(1);
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'vampire-package-smoke-'));
const installDirectory = join(temporaryDirectory, 'install');
const workspaceDirectory = join(temporaryDirectory, 'workspace');
const stateDirectory = join(temporaryDirectory, 'state');
const resolvedPackageSource = packageSource.endsWith('.tgz') ? resolve(packageSource) : packageSource;
const smokeToken = 'vampire-package-smoke-token';

try {
  await mkdir(workspaceDirectory, { recursive: true });
  await installPackage(resolvedPackageSource, installDirectory);

  const installedPackageDirectory = join(installDirectory, 'node_modules', 'vampire');
  const manifest = JSON.parse(await readFile(join(installedPackageDirectory, 'package.json'), 'utf8')) as {
    version?: string;
  };
  if (manifest.version !== expectedVersion) {
    throw new Error(`Installed vampire@${manifest.version}; expected vampire@${expectedVersion}.`);
  }

  const port = await availablePort();
  const child = spawn(process.execPath, [join(installedPackageDirectory, 'bin', 'vampire.js')], {
    cwd: workspaceDirectory,
    env: runtimeEnvironment(port, stateDirectory, workspaceDirectory, smokeToken),
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
    await waitForHttpServer(child, `${baseUrl}/`, () => output);
    await verifyAuthentication(baseUrl, smokeToken);
  } finally {
    await stopProcess(child);
  }

  console.log(`Verified installed vampire@${expectedVersion} from ${packageSource}.`);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
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
        { timeout: 120_000 }
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

function runtimeEnvironment(port: number, statePath: string, workspacePath: string, token: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    VAMPIRE_HOST: '127.0.0.1',
    VAMPIRE_PORT: String(port),
    VAMPIRE_STATE_DIR: statePath,
    VAMPIRE_TOKEN: token,
    VAMPIRE_WORKSPACE_ROOTS: workspacePath,
  };
  delete environment.VAMPIRE_ADAPTER_ORIGIN;
  delete environment.VAMPIRE_ADAPTER_PROTOCOL_HEADER;
  return environment;
}

async function verifyAuthentication(baseUrl: string, token: string): Promise<void> {
  const login = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (!login.ok) throw new Error(`Packaged CLI rejected its configured access token with status ${login.status}.`);

  const setCookie = login.headers.get('set-cookie');
  if (!setCookie) throw new Error('Packaged CLI did not create an authentication cookie.');
  if (/(?:^|;\s*)Secure(?:;|$)/i.test(setCookie)) {
    throw new Error('Packaged CLI marked its direct HTTP authentication cookie as Secure.');
  }

  const cookie = setCookie.split(';', 1)[0];
  const workspaces = await fetch(`${baseUrl}/api/workspaces`, { headers: { cookie } });
  if (!workspaces.ok) {
    throw new Error(`Packaged CLI did not accept its authentication cookie; status ${workspaces.status}.`);
  }
}

async function waitForHttpServer(child: ChildProcess, url: string, output: () => string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Packaged CLI exited with code ${child.exitCode}.\n${output()}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // The server may still be starting.
    }
    await delay(100);
  }
  throw new Error(`Packaged CLI did not serve HTTP within 20 seconds.\n${output()}`);
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
