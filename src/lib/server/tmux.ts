import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import type { TmuxStatus } from '$lib/tmux-status';

const execFile = promisify(execFileCallback);
const MAX_INPUT_BYTES = 64 * 1024;

function tmuxInstallGuide(): TmuxStatus['install'] {
	if (process.platform === 'darwin') {
		return {
			platform: 'macOS',
			commands: ['brew install tmux'],
			note: 'If Homebrew is not installed, install it from brew.sh first.'
		};
	}

	if (process.platform === 'linux') {
		return {
			platform: 'Linux',
			commands: [
				'sudo apt-get update && sudo apt-get install -y tmux',
				'sudo dnf install -y tmux',
				'sudo pacman -S tmux'
			],
			note: 'Use the command matching your Linux distribution. Vampire does not run package managers or sudo automatically.'
		};
	}

	if (process.platform === 'win32') {
		return {
			platform: 'Windows',
			commands: ['wsl --install', 'sudo apt-get update && sudo apt-get install -y tmux'],
			note: 'Run the second command inside WSL, and run Vampire inside that WSL environment. Windows browsers can still connect to it.'
		};
	}

	return {
		platform: process.platform,
		commands: ['Install tmux with your operating system package manager.'],
		note: 'After installation, reload Vampire to check again.'
	};
}

export function isTmuxUnavailable(error: unknown): boolean {
	const details = error as NodeJS.ErrnoException & { stderr?: string };
	return details?.code === 'ENOENT'
		|| /(?:tmux|command) (?:not found|not recognized)/i.test(`${details?.message ?? ''} ${details?.stderr ?? ''}`);
}

export async function getTmuxStatus(): Promise<TmuxStatus> {
	try {
		const { stdout } = await execFile('tmux', ['-V'], { timeout: 2_000 });
		return { available: true, version: stdout.trim() || null, install: tmuxInstallGuide() };
	} catch {
		return { available: false, version: null, install: tmuxInstallGuide() };
	}
}

export interface TmuxSession {
	name: string;
	createdAt: number | null;
	lastOutputAt: number | null;
	attachedClients: number;
	foregroundProcess: TmuxProcessHint | null;
}

export type TmuxProcessKind = 'shell' | 'agent' | 'command';

export interface TmuxProcessHint {
	kind: TmuxProcessKind;
	label: string;
}

interface ProcessRecord {
	pid: number;
	ppid: number;
	pgid: number;
	tpgid: number;
	command: string;
}

const SHELL_COMMANDS = new Set(['bash', 'dash', 'fish', 'ksh', 'nu', 'powershell', 'pwsh', 'sh', 'tcsh', 'zsh']);
const COMMAND_LAUNCHERS = new Set([
	'bun',
	'bunx',
	'cargo',
	'deno',
	'go',
	'java',
	'node',
	'nodejs',
	'npx',
	'npm',
	'perl',
	'php',
	'pipx',
	'pnpm',
	'poetry',
	'python',
	'python3',
	'ruby',
	'ts-node',
	'tsx',
	'uv',
	'uvx',
	'yarn',
	'yarnpkg'
]);
const LAUNCHER_WORDS_TO_SKIP = new Set(['command', 'dlx', 'exec', 'run', 'script', 'start', 'x']);
const LAUNCHER_OPTIONS_WITH_VALUE = new Set(['--cwd', '--import', '--loader', '--package', '--prefix', '--require', '-c', '-r']);

function parseProcessTable(output: string): Map<number, ProcessRecord> {
	const processes = new Map<number, ProcessRecord>();
	for (const line of output.split('\n')) {
		const fields = line.trim().split(/\s+/);
		if (fields.length < 5) continue;
		const [pid, ppid, pgid, tpgid] = fields.slice(0, 4).map(Number);
		if (![pid, ppid, pgid, tpgid].every(Number.isFinite)) continue;
		processes.set(pid, { pid, ppid, pgid, tpgid, command: fields.slice(4).join(' ') });
	}
	return processes;
}

function matchesTool(value: string, tool: 'codex' | 'claude'): boolean {
	return new RegExp(`(?:^|[^a-z])${tool}(?:$|[^a-z])`, 'i').test(value);
}

function executableName(command: string): string {
	const executable = command.trim().split(/\s+/, 1)[0] ?? '';
	return executable.split('/').pop()?.replace(/^-/, '') || '';
}

function cleanCommandToken(token: string): string {
	return token.replace(/^[('"`]+|[)'"`,;]+$/g, '');
}

function invokedCommandLabel(command: string, fallback: string): string {
	const executable = executableName(command);
	if (COMMAND_LAUNCHERS.has(executable.toLowerCase())) {
		const tokens = command.trim().split(/\s+/).slice(1).map(cleanCommandToken);
		let skipNext = false;
		for (const token of tokens) {
			if (!token) continue;
			if (skipNext) {
				skipNext = false;
				continue;
			}
			const lowerToken = token.toLowerCase();
			if (LAUNCHER_OPTIONS_WITH_VALUE.has(lowerToken)) {
				skipNext = true;
				continue;
			}
			if (token.startsWith('-') || LAUNCHER_WORDS_TO_SKIP.has(lowerToken)) continue;

			const candidate = token.split('/').pop() ?? token;
			const label = candidate.replace(/\.(?:cjs|cts|go|jar|java|js|mjs|mts|php|py|rb|rs|ts)$/i, '');
			if (label) return label;
		}
	}

	return executable || executableName(fallback) || 'Process';
}

function classifyProcess(
	currentCommand: string,
	title: string,
	panePid: number,
	processes: Map<number, ProcessRecord>
): TmuxProcessHint | null {
	if (!currentCommand && !title && panePid <= 0) return null;
	const paneProcess = processes.get(panePid);
	const foregroundProcess = paneProcess?.tpgid ? processes.get(paneProcess.tpgid) : undefined;
	const candidates = [foregroundProcess?.command, paneProcess?.command, currentCommand, title]
		.filter((value): value is string => Boolean(value));
	const combined = candidates.join(' ');

	if (matchesTool(combined, 'codex')) return { kind: 'agent', label: 'Codex' };
	if (matchesTool(combined, 'claude')) return { kind: 'agent', label: 'Claude' };

	const command = invokedCommandLabel(foregroundProcess?.command || currentCommand, currentCommand);
	if (SHELL_COMMANDS.has(command.toLowerCase())) {
		return { kind: 'shell', label: 'Shell' };
	}
	return { kind: 'command', label: command || 'Process' };
}

export async function createTmuxSession(name: string, cwd: string): Promise<void> {
	await execFile('tmux', [
		'new-session',
		'-d',
		'-s',
		name,
		'-c',
		cwd
	]);
}

export async function sendTmuxInput(name: string, data: string): Promise<void> {
	if (Buffer.byteLength(data) > MAX_INPUT_BYTES) throw new Error('Input is too large.');
	await execFile('tmux', ['send-keys', '-t', name, '-l', '--', data]);
}

export async function killTmuxSession(name: string): Promise<void> {
	try {
		await execFile('tmux', ['kill-session', '-t', name]);
	} catch (error) {
		const details = error as NodeJS.ErrnoException & { stderr?: string };
		if (Number(details.code) === 1 && /(?:can't find|no server running)/i.test(details.stderr ?? '')) return;
		throw error;
	}
}

export function parseTmuxSessions(output: string): TmuxSession[] {
	return parseTmuxSessionsWithProcesses(output, new Map());
}

function parseTmuxSessionsWithProcesses(output: string, processes: Map<number, ProcessRecord>): TmuxSession[] {
	return output
		.trim()
		.split('\n')
		.filter(Boolean)
		.flatMap((line) => {
			const [name, createdAt, lastOutputAt, attachedClients, currentCommand, panePidValue, title] = line.split('\t');
			if (!name) return [];

			const created = Number(createdAt);
			const lastOutput = Number(lastOutputAt);
			const attached = Number(attachedClients);
			const panePid = Number(panePidValue);
			return [{
				name,
				createdAt: Number.isFinite(created) ? created * 1_000 : null,
				lastOutputAt: Number.isFinite(lastOutput) ? lastOutput * 1_000 : null,
				attachedClients: Number.isFinite(attached) ? attached : 0,
				foregroundProcess: classifyProcess(
					currentCommand ?? '',
					title ?? '',
					Number.isFinite(panePid) ? panePid : 0,
					processes
				)
			}];
		});
}

export async function listTmuxSessions(): Promise<TmuxSession[]> {
	try {
		const [{ stdout }, processTable] = await Promise.all([
			execFile('tmux', [
				'list-sessions',
				'-F',
				'#{session_name}\t#{session_created}\t#{window_activity}\t#{session_attached}\t#{pane_current_command}\t#{pane_pid}\t#{pane_title}'
			]),
			execFile('ps', ['-axo', 'pid=,ppid=,pgid=,tpgid=,command='], { maxBuffer: 2 * 1024 * 1024 })
				.then(({ stdout: processOutput }) => parseProcessTable(processOutput))
				.catch(() => new Map<number, ProcessRecord>())
		]);
		return parseTmuxSessionsWithProcesses(stdout, processTable);
	} catch (error) {
		const details = error as NodeJS.ErrnoException & { stderr?: string };
		if (isTmuxUnavailable(error) || (Number(details.code) === 1 && /no server running/i.test(details.stderr ?? ''))) return [];
		throw error;
	}
}
