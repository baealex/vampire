import { execFile, spawn } from 'node:child_process';
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
	console.error('Usage: node scripts/package-smoke.mjs <package.tgz|package-spec> <expected-version>');
	process.exit(1);
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'vampire-package-smoke-'));
const installDirectory = join(temporaryDirectory, 'install');
const workspaceDirectory = join(temporaryDirectory, 'workspace');
const stateDirectory = join(temporaryDirectory, 'state');
const resolvedPackageSource = packageSource.endsWith('.tgz') ? resolve(packageSource) : packageSource;

try {
	await mkdir(workspaceDirectory, { recursive: true });
	await installPackage(resolvedPackageSource, installDirectory);

	const installedPackageDirectory = join(installDirectory, 'node_modules', 'vampire');
	const manifest = JSON.parse(await readFile(join(installedPackageDirectory, 'package.json'), 'utf8'));
	if (manifest.version !== expectedVersion) {
		throw new Error(`Installed vampire@${manifest.version}; expected vampire@${expectedVersion}.`);
	}

	const port = await availablePort();
	const child = spawn(process.execPath, [join(installedPackageDirectory, 'bin', 'vampire.mjs')], {
		cwd: workspaceDirectory,
		env: runtimeEnvironment(port, stateDirectory, workspaceDirectory),
		stdio: ['ignore', 'pipe', 'pipe']
	});
	let output = '';
	child.stdout.on('data', (chunk) => { output += chunk; });
	child.stderr.on('data', (chunk) => { output += chunk; });

	try {
		await waitForHttpServer(child, `http://127.0.0.1:${port}/`, () => output);
	} finally {
		await stopProcess(child);
	}

	console.log(`Verified installed vampire@${expectedVersion} from ${packageSource}.`);
} finally {
	await rm(temporaryDirectory, { recursive: true, force: true });
}

async function installPackage(source, directory) {
	const attempts = source.endsWith('.tgz') ? 1 : 60;
	let lastError;

	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		await rm(directory, { recursive: true, force: true });
		await mkdir(directory, { recursive: true });
		try {
			await execFileAsync(npmCommand(), [
				'install',
				'--ignore-scripts',
				'--no-audit',
				'--no-fund',
				'--no-package-lock',
				'--prefix', directory,
				source
			], { timeout: 120_000 });
			return;
		} catch (error) {
			lastError = error;
			if (attempt < attempts) await delay(5_000);
		}
	}

	throw lastError;
}

function npmCommand() {
	return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

async function availablePort() {
	const server = createServer();
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const address = server.address();
	await new Promise((resolveClose, rejectClose) => {
		server.close((error) => error ? rejectClose(error) : resolveClose());
	});
	if (!address || typeof address === 'string') throw new Error('Could not reserve a smoke-test port.');
	return address.port;
}

function runtimeEnvironment(port, statePath, workspacePath) {
	const environment = {
		...process.env,
		VAMPIRE_HOST: '127.0.0.1',
		VAMPIRE_PORT: String(port),
		VAMPIRE_STATE_DIR: statePath,
		VAMPIRE_WORKSPACE_ROOTS: workspacePath
	};
	delete environment.VAMPIRE_ADAPTER_ORIGIN;
	delete environment.VAMPIRE_TOKEN;
	return environment;
}

async function waitForHttpServer(child, url, output) {
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

async function stopProcess(child) {
	if (child.exitCode !== null) return;
	child.kill('SIGTERM');
	await new Promise((resolveExit) => {
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

function delay(milliseconds) {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
