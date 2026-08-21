import { spawn, type ChildProcess } from 'node:child_process';

const corepackCommand = process.platform === 'win32' ? 'corepack.cmd' : 'corepack';
const environment = {
  ...process.env,
  VAMPIRE_SVELTEKIT_OUT_DIR: '.svelte-kit-e2e',
  VAMPIRE_BUILD_DIR: 'build-e2e',
  VAMPIRE_VITE_CACHE_DIR: 'node_modules/.vite-e2e',
};

function start(command: string, args: string[]): ChildProcess {
  return spawn(command, args, {
    env: environment,
    stdio: 'inherit',
  });
}

function exitCode(child: ChildProcess): Promise<number> {
  return new Promise((resolve) => {
    child.once('error', () => resolve(1));
    child.once('exit', (code) => resolve(code ?? 1));
  });
}

const build = start(corepackCommand, ['pnpm', 'build']);
const buildExitCode = await exitCode(build);

if (buildExitCode !== 0) {
  process.exitCode = buildExitCode;
} else {
  const server = start(process.execPath, ['e2e/server.ts']);
  let stopping = false;
  const stopServer = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    server.kill(signal);
  };

  process.once('SIGINT', () => stopServer('SIGINT'));
  process.once('SIGTERM', () => stopServer('SIGTERM'));
  process.exitCode = await exitCode(server);
}
