import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import type { TmuxStatus } from '$lib/tmux-status';

const execFile = promisify(execFileCallback);
const MAX_INPUT_BYTES = 64 * 1024;
const VAMPIRE_SERVER_ENVIRONMENT_KEYS = [
	'VAMPIRE_ADAPTER_BODY_SIZE_LIMIT',
	'VAMPIRE_ADAPTER_ORIGIN',
	'VAMPIRE_HOST',
	'VAMPIRE_PORT',
	'VAMPIRE_STATE_DIR',
	'VAMPIRE_TOKEN'
];

export function tmuxSessionLaunch(
	name: string,
	cwd: string,
	sourceEnvironment: NodeJS.ProcessEnv = process.env
): { arguments: string[]; environment: NodeJS.ProcessEnv } {
	const serverEnvironmentKeys = [...new Set([
		...VAMPIRE_SERVER_ENVIRONMENT_KEYS,
		...Object.keys(sourceEnvironment).filter((key) => key.startsWith('VAMPIRE_'))
	])].sort();
	const environment = { ...sourceEnvironment };
	for (const key of serverEnvironmentKeys) delete environment[key];

	return {
		arguments: [
			...serverEnvironmentKeys.flatMap((key) => ['set-environment', '-gr', key, ';']),
			'new-session',
			'-d',
			'-s',
			name,
			'-c',
			cwd
		],
		environment
	};
}

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

export type TmuxProcessKind = 'shell' | 'command';

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

function executableName(command: string): string {
	const tokens = command.trim().split(/\s+/);
	const executable = tokens[0] ?? '';
	const executableLabel = executable.split('/').pop()?.replace(/^-/, '').toLowerCase() ?? '';
	const nodeScript = executableLabel === 'node'
		? tokens.slice(1).find((token) => token.includes('/') || /\.(?:cjs|mjs|js|ts)$/.test(token))
		: undefined;
	const label = nodeScript ?? executable;
	return label.split('/').pop()?.replace(/^-/, '').replace(/\.(?:cjs|mjs|js|ts)$/, '').toLowerCase() || '';
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
	const command = executableName(foregroundProcess?.command || currentCommand || title) || 'process';
	if (SHELL_COMMANDS.has(command.toLowerCase())) {
		return { kind: 'shell', label: command };
	}
	return { kind: 'command', label: command };
}

export async function createTmuxSession(name: string, cwd: string): Promise<void> {
	const launch = tmuxSessionLaunch(name, cwd);
	await execFile('tmux', launch.arguments, { env: launch.environment });
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
