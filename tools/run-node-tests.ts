import { execFile as execFileCallback, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const repositoryRoot = resolve(import.meta.dirname, '..');
const execFile = promisify(execFileCallback);

async function collectNodeTests(directory: string): Promise<string[]> {
  const tests: string[] = [];

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      tests.push(...(await collectNodeTests(path)));
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith('.test.ts') || entry.name.endsWith('.component.test.ts')) {
      continue;
    }

    tests.push(path);
  }

  return tests;
}

const tests = (
  await Promise.all(['src', 'tools'].map((directory) => collectNodeTests(join(repositoryRoot, directory))))
)
  .flat()
  .sort();

if (tests.length === 0) throw new Error('No Node.js tests were found.');

function runTests(environment: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolveRun) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        resolve(repositoryRoot, 'tools/register-ts-alias.mjs'),
        '--test',
        ...tests.map((path) => relative(repositoryRoot, path)),
      ],
      { cwd: repositoryRoot, env: environment, stdio: 'inherit' }
    );

    child.once('error', () => resolveRun(1));
    child.once('exit', (code) => resolveRun(code ?? 1));
  });
}

const runtimeDirectory = await mkdtemp(join(tmpdir(), 'vampire-node-tests-'));
const stateDirectory = join(runtimeDirectory, 'state');
const tmuxSocketName = `vampire-test-${process.pid}-${randomUUID().slice(0, 8)}`;
await mkdir(stateDirectory, { mode: 0o700 });

const testEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  VAMPIRE_STATE_DIR: stateDirectory,
  VAMPIRE_TMUX_SOCKET_NAME: tmuxSocketName,
};
delete testEnvironment.VAMPIRE_SAFE_DEVELOPMENT;

try {
  process.exitCode = await runTests(testEnvironment);
} finally {
  await execFile('tmux', ['-L', tmuxSocketName, 'kill-server']).catch(() => undefined);
  await rm(runtimeDirectory, { recursive: true, force: true });
}
