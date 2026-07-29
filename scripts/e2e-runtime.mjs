import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const E2E_HOST = '127.0.0.1';
export const E2E_PORT = 7_678;
export const E2E_TOKEN = 'vampire-playwright-token';
export const E2E_BASE_URL = `http://${E2E_HOST}:${E2E_PORT}`;
export const E2E_RUNTIME_DIRECTORY = join(repositoryRoot, 'test-results', 'e2e-runtime');
export const E2E_STATE_DIRECTORY = join(E2E_RUNTIME_DIRECTORY, 'state');
export const E2E_WORKSPACE_DIRECTORY = join(E2E_RUNTIME_DIRECTORY, 'workspace');

const TEST_TMUX_SESSION_PATTERN = /^vampire-[a-f0-9]{8}$/;

async function registeredTmuxSessions() {
	try {
		const raw = await readFile(join(E2E_STATE_DIRECTORY, 'sessions.json'), 'utf8');
		const parsed = JSON.parse(raw);
		if (!parsed || !Array.isArray(parsed.sessions)) return [];
		return parsed.sessions
			.map((session) => session?.tmuxSession)
			.filter((name) => typeof name === 'string' && TEST_TMUX_SESSION_PATTERN.test(name));
	} catch (error) {
		if (error?.code === 'ENOENT' || error instanceof SyntaxError) return [];
		throw error;
	}
}

export async function cleanE2ERuntime() {
	for (const sessionName of await registeredTmuxSessions()) {
		await run('tmux', ['kill-session', '-t', sessionName]).catch(() => undefined);
	}
	await rm(E2E_RUNTIME_DIRECTORY, { recursive: true, force: true });
}

export async function prepareE2ERuntime() {
	await cleanE2ERuntime();
	await mkdir(E2E_WORKSPACE_DIRECTORY, { recursive: true });
	await writeFile(join(E2E_WORKSPACE_DIRECTORY, 'conflict.txt'), 'initial browser test content\n', 'utf8');
}
