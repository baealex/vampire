import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const E2E_HOST = '127.0.0.1';
const configuredE2EPort = Number.parseInt(process.env.VAMPIRE_E2E_PORT ?? '', 10);
export const E2E_PORT = Number.isInteger(configuredE2EPort) && configuredE2EPort > 0 ? configuredE2EPort : 17_678;
export const E2E_TOKEN = 'vampire-playwright-token';
export const E2E_BASE_URL = `http://${E2E_HOST}:${E2E_PORT}`;
export const E2E_RUNTIME_DIRECTORY = join(repositoryRoot, 'test-results', 'e2e-runtime');
export const E2E_STATE_DIRECTORY = join(E2E_RUNTIME_DIRECTORY, 'state');
export const E2E_WORKSPACE_DIRECTORY = join(E2E_RUNTIME_DIRECTORY, 'workspace');
export const E2E_TMUX_SOCKET_NAME = `vampire-e2e-${createHash('sha256')
  .update(repositoryRoot)
  .digest('hex')
  .slice(0, 12)}`;

const TEST_TMUX_WORKSPACE_PATTERN = /^vampire-[a-f0-9]{8}$/;

async function registeredTmuxSessions(): Promise<string[]> {
  try {
    const raw = await readFile(join(E2E_STATE_DIRECTORY, 'registry.json'), 'utf8');
    const parsed = JSON.parse(raw) as { workspaces?: Array<{ tmuxSession?: unknown } | null> };
    if (!parsed || !Array.isArray(parsed.workspaces)) return [];
    return parsed.workspaces
      .map((workspace) => workspace?.tmuxSession)
      .filter((name): name is string => typeof name === 'string' && TEST_TMUX_WORKSPACE_PATTERN.test(name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT' || error instanceof SyntaxError) return [];
    throw error;
  }
}

export async function cleanE2ERuntime(): Promise<void> {
  for (const workspaceName of await registeredTmuxSessions()) {
    await run('tmux', ['-L', E2E_TMUX_SOCKET_NAME, 'kill-session', '-t', workspaceName]).catch(() => undefined);
  }
  await run('tmux', ['-L', E2E_TMUX_SOCKET_NAME, 'kill-server']).catch(() => undefined);
  await rm(E2E_RUNTIME_DIRECTORY, { recursive: true, force: true });
}

export async function prepareE2ERuntime(): Promise<void> {
  await cleanE2ERuntime();
  await mkdir(E2E_WORKSPACE_DIRECTORY, { recursive: true });
  await writeFile(join(E2E_WORKSPACE_DIRECTORY, 'conflict.txt'), 'initial browser test content\n', 'utf8');
}
