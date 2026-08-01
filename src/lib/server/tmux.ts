import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import type { TmuxStatus } from '../tmux-status.ts';

const execFile = promisify(execFileCallback);
const MAX_INPUT_BYTES = 64 * 1024;
const TMUX_WINDOW_FORMAT = '#{session_name}\t#{session_created}\t#{session_attached}\t#{window_index}\t#{window_id}\t#{window_name}\t#{window_active}\t#{window_activity}\t#{pane_id}\t#{pane_current_command}\t#{pane_pid}\t#{pane_title}\t#{@vampire_background_command}\t#{@vampire_background_started_at}\t#{pane_dead}\t#{pane_dead_status}';
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
			cwd,
			'-P',
			'-F',
			TMUX_WINDOW_FORMAT
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
	terminals: TmuxTerminal[];
}

export interface TmuxSessionActivity {
	name: string;
	lastOutputAt: number | null;
	mainLastOutputAt: number | null;
}

export type TmuxProcessKind = 'shell' | 'command';

export interface TmuxProcessHint {
	kind: TmuxProcessKind;
	label: string;
}

export interface TmuxTerminal {
	id: string;
	index: number;
	name: string;
	active: boolean;
	lastOutputAt: number | null;
	foregroundProcess: TmuxProcessHint | null;
	command: string | null;
	startedAt: number | null;
	state: 'running' | 'exited';
	exitCode: number | null;
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
	const executable = command.trim().split(/\s+/, 1)[0] ?? '';
	return executable.split('/').pop()?.replace(/^-/, '').toLowerCase() || '';
}

function foregroundProcessForPane(panePid: number, processes: Map<number, ProcessRecord>): ProcessRecord | undefined {
	const paneProcess = processes.get(panePid);
	let foregroundProcess = paneProcess?.tpgid ? processes.get(paneProcess.tpgid) : undefined;
	while (foregroundProcess && !SHELL_COMMANDS.has(executableName(foregroundProcess.command))) {
		const children = [...processes.values()].filter(
			(candidate) => candidate.ppid === foregroundProcess?.pid && candidate.tpgid === foregroundProcess?.tpgid
		);
		if (children.length !== 1) break;
		foregroundProcess = children[0];
	}
	return foregroundProcess;
}

function classifyProcess(
	currentCommand: string,
	title: string,
	panePid: number,
	processes: Map<number, ProcessRecord>
): TmuxProcessHint | null {
	if (!currentCommand && !title && panePid <= 0) return null;
	const foregroundProcess = foregroundProcessForPane(panePid, processes);
	const command = executableName(foregroundProcess?.command || currentCommand || title) || 'process';
	if (SHELL_COMMANDS.has(command.toLowerCase())) {
		return { kind: 'shell', label: command };
	}
	return { kind: 'command', label: command };
}

export async function createTmuxSession(name: string, cwd: string): Promise<TmuxSession> {
	const launch = tmuxSessionLaunch(name, cwd);
	const { stdout } = await execFile('tmux', launch.arguments, { env: launch.environment });
	const session = parseTmuxSessionsWithProcesses(stdout, new Map())[0];
	if (!session) throw new Error('tmux did not describe the new shell session.');
	return session;
}

function shellArgument(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function backgroundWindowName(command: string): string {
	return command.length > 48 ? `${command.slice(0, 47)}…` : command;
}

async function assertTmuxTerminalOwner(name: string, terminalId: string): Promise<void> {
	if (!/^@\d+$/.test(terminalId)) throw new Error('Background process identifier is invalid.');
	const { stdout } = await execFile('tmux', [
		'display-message',
		'-p',
		'-t',
		terminalId,
		'#{session_name}'
	]);
	if (stdout.trim() !== name) throw new Error('Background process does not belong to this workspace.');
}

export async function createTmuxBackgroundProcess(name: string, cwd: string, command: string): Promise<TmuxTerminal> {
	const startedAt = Date.now();
	const { stdout } = await execFile('tmux', [
		'new-window',
		'-d',
		'-P',
		'-F',
		'#{window_id}',
		'-t',
		`${name}:`,
		'-c',
		cwd,
		'-n',
		backgroundWindowName(command)
	]);
	const terminalId = stdout.trim();
	if (!/^@\d+$/.test(terminalId)) throw new Error('tmux did not describe the new background process.');

	try {
		await execFile('tmux', [
			'set-option', '-w', '-t', terminalId, 'remain-on-exit', 'on', ';',
			'set-option', '-w', '-t', terminalId, 'automatic-rename', 'off', ';',
			'set-option', '-w', '-t', terminalId, 'allow-rename', 'off', ';',
			'set-option', '-w', '-t', terminalId, '@vampire_background_command', command, ';',
			'set-option', '-w', '-t', terminalId, '@vampire_background_started_at', String(startedAt)
		]);
		const shell = process.env.SHELL?.trim() || '/bin/sh';
		await execFile('tmux', [
			'respawn-pane',
			'-k',
			'-t',
			terminalId,
			`exec ${shellArgument(shell)} -lc ${shellArgument(command)}`
		]);
		const terminal = (await listTmuxSessions())
			.find((session) => session.name === name)
			?.terminals.find((candidate) => candidate.id === terminalId);
		if (!terminal) throw new Error('tmux did not describe the new background process.');
		return terminal;
	} catch (error) {
		await execFile('tmux', ['kill-window', '-t', terminalId]).catch(() => undefined);
		throw error;
	}
}

export async function killTmuxBackgroundProcess(name: string, terminalId: string): Promise<void> {
	await assertTmuxTerminalOwner(name, terminalId);
	await execFile('tmux', ['kill-window', '-t', terminalId]);
}

export async function captureTmuxBackgroundOutput(name: string, terminalId: string): Promise<string> {
	await assertTmuxTerminalOwner(name, terminalId);
	const { stdout } = await execFile('tmux', ['capture-pane', '-p', '-S', '-', '-t', terminalId], {
		maxBuffer: 512 * 1024,
		timeout: 3_000
	});
	return stdout;
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

export function parseTmuxSessions(output: string, processes = new Map<number, ProcessRecord>()): TmuxSession[] {
	return parseTmuxSessionsWithProcesses(output, processes);
}

export function parseTmuxSessionActivity(output: string): TmuxSessionActivity[] {
	const activityByName = new Map<string, {
		mainWindowIndex: number;
		mainLastOutputAt: number | null;
	}>();
	for (const line of output.trim().split('\n').filter(Boolean)) {
		const [name, windowIndexValue, lastOutputAtValue] = line.split('\t');
		if (!name) continue;
		const windowIndex = Number(lastOutputAtValue === undefined ? 0 : windowIndexValue);
		const timestamp = Number(lastOutputAtValue ?? windowIndexValue);
		const lastOutputAt = Number.isFinite(timestamp) ? timestamp * 1_000 : null;
		const previous = activityByName.get(name);
		activityByName.set(name, {
			mainWindowIndex: Math.min(previous?.mainWindowIndex ?? Number.MAX_SAFE_INTEGER, windowIndex),
			mainLastOutputAt: !previous || windowIndex < previous.mainWindowIndex
				? lastOutputAt
				: windowIndex === previous.mainWindowIndex
					? lastOutputAt
					: previous.mainLastOutputAt
		});
	}
	return [...activityByName].map(([name, activity]) => ({
		name,
		lastOutputAt: activity.mainLastOutputAt,
		mainLastOutputAt: activity.mainLastOutputAt
	}));
}

function parseTmuxSessionsWithProcesses(output: string, processes: Map<number, ProcessRecord>): TmuxSession[] {
	type WindowRow = {
		sessionName: string;
		createdAt: number | null;
		attachedClients: number;
		terminal: TmuxTerminal;
	};
	const rows: WindowRow[] = output
		.trim()
		.split('\n')
		.filter(Boolean)
		.flatMap((line) => {
			const [
				sessionName,
				createdAt,
				attachedClients,
				windowIndex,
				windowId,
				windowName,
				windowActive,
				lastOutputAt,
				_paneId,
				currentCommand,
				panePidValue,
				title,
				backgroundCommand,
				backgroundStartedAt,
				paneDead,
				paneDeadStatus
			] = line.split('\t');
			const terminalId = windowId ?? '';
			if (!sessionName || !/^@\d+$/.test(terminalId)) return [];

			const created = Number(createdAt);
			const lastOutput = Number(lastOutputAt);
			const attached = Number(attachedClients);
			const index = Number(windowIndex);
			const panePid = Number(panePidValue);
			const startedAt = Number(backgroundStartedAt);
			const exitCode = Number(paneDeadStatus);
			const exited = paneDead === '1';
			return [{
				sessionName,
				createdAt: Number.isFinite(created) ? created * 1_000 : null,
				attachedClients: Number.isFinite(attached) ? attached : 0,
				terminal: {
					id: terminalId,
					index: Number.isInteger(index) && index >= 0 ? index : 0,
					name: windowName || 'terminal',
					active: windowActive === '1',
					lastOutputAt: Number.isFinite(lastOutput) ? lastOutput * 1_000 : null,
					foregroundProcess: exited ? null : classifyProcess(
						currentCommand ?? '',
						title ?? '',
						Number.isFinite(panePid) ? panePid : 0,
						processes
					),
					command: backgroundCommand || null,
					startedAt: Number.isFinite(startedAt) && startedAt > 0 ? startedAt : null,
					state: exited ? 'exited' : 'running',
					exitCode: exited && Number.isInteger(exitCode) ? exitCode : null
				}
			}];
		});
	const rowsBySession = new Map<string, WindowRow[]>();
	for (const row of rows) {
		const sessionRows = rowsBySession.get(row.sessionName) ?? [];
		sessionRows.push(row);
		rowsBySession.set(row.sessionName, sessionRows);
	}

	return [...rowsBySession].map(([name, sessionRows]) => {
		const terminals = sessionRows.map((row) => row.terminal).sort((left, right) => left.index - right.index);
		const mainTerminal = terminals[0];
		return {
			name,
			createdAt: sessionRows[0]?.createdAt ?? null,
			lastOutputAt: mainTerminal?.lastOutputAt ?? null,
			attachedClients: Math.max(...sessionRows.map((row) => row.attachedClients), 0),
			foregroundProcess: mainTerminal?.foregroundProcess ?? null,
			terminals
		};
	});
}

export async function listTmuxSessions(): Promise<TmuxSession[]> {
	try {
		const [{ stdout }, processTable] = await Promise.all([
			execFile('tmux', [
				'list-windows',
				'-a',
				'-F',
				TMUX_WINDOW_FORMAT
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

export async function listTmuxSessionActivity(): Promise<TmuxSessionActivity[]> {
	try {
		const { stdout } = await execFile('tmux', [
			'list-windows',
			'-a',
			'-F',
			'#{session_name}\t#{window_index}\t#{window_activity}'
		]);
		return parseTmuxSessionActivity(stdout);
	} catch (error) {
		const details = error as NodeJS.ErrnoException & { stderr?: string };
		if (isTmuxUnavailable(error) || (Number(details.code) === 1 && /no server running/i.test(details.stderr ?? ''))) return [];
		throw error;
	}
}
