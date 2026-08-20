import { spawn, type ChildProcess } from 'node:child_process';

export const STATUS_PLUGIN_COMMAND_TIMEOUT_MS = 10_000;
export const STATUS_PLUGIN_COMMAND_MAX_OUTPUT_BYTES = 32 * 1_024;

export type StatusPluginCommandErrorKind = 'abort' | 'exit' | 'output-limit' | 'spawn' | 'timeout';

export interface StatusPluginCommandResult {
	stdout: string;
	stderr: string;
}

export interface StatusPluginCommandOptions {
	timeoutMs?: number;
	maxOutputBytes?: number;
	signal?: AbortSignal;
}

export class StatusPluginCommandError extends Error {
	kind: StatusPluginCommandErrorKind;
	exitCode: number | null;
	stdout: string;
	stderr: string;

	constructor(
		message: string,
		kind: StatusPluginCommandErrorKind,
		result: StatusPluginCommandResult = { stdout: '', stderr: '' },
		exitCode: number | null = null,
		options?: ErrorOptions
	) {
		super(message, options);
		this.name = 'StatusPluginCommandError';
		this.kind = kind;
		this.exitCode = exitCode;
		this.stdout = result.stdout;
		this.stderr = result.stderr;
	}
}

function terminateProcess(child: ChildProcess, signal: NodeJS.Signals): void {
	if (child.pid === undefined) return;
	try {
		if (process.platform === 'win32') child.kill(signal);
		else process.kill(-child.pid, signal);
	} catch {
		child.kill(signal);
	}
}

function killRemainingProcessGroup(child: ChildProcess): void {
	if (process.platform === 'win32' || child.pid === undefined) return;
	try {
		process.kill(-child.pid, 'SIGKILL');
	} catch {
		// The group normally disappears with the shell. Any remaining children
		// are status-command leftovers and must not survive the refresh.
	}
}

export async function runStatusPluginCommand(
	command: string,
	options: StatusPluginCommandOptions = {}
): Promise<StatusPluginCommandResult> {
	if (options.signal?.aborted) {
		throw new StatusPluginCommandError('Status plugin command was cancelled.', 'abort');
	}
	const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? STATUS_PLUGIN_COMMAND_TIMEOUT_MS, 60_000));
	const maxOutputBytes = Math.max(1, Math.min(
		options.maxOutputBytes ?? STATUS_PLUGIN_COMMAND_MAX_OUTPUT_BYTES,
		STATUS_PLUGIN_COMMAND_MAX_OUTPUT_BYTES
	));
	const shell = process.env.SHELL?.trim() || (process.platform === 'win32' ? 'cmd.exe' : '/bin/sh');
	const shellArguments = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-lc', command];

	return await new Promise<StatusPluginCommandResult>((resolve, reject) => {
		const child = spawn(shell, shellArguments, {
			detached: process.platform !== 'win32',
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let outputBytes = 0;
		let terminalError: StatusPluginCommandError | undefined;
		let settled = false;
		let forceKillTimer: NodeJS.Timeout | undefined;

		const result = (): StatusPluginCommandResult => ({
			stdout: Buffer.concat(stdout).toString('utf8'),
			stderr: Buffer.concat(stderr).toString('utf8')
		});
		const cleanup = () => {
			clearTimeout(timeoutTimer);
			if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
			options.signal?.removeEventListener('abort', abort);
		};
		const terminate = (error: StatusPluginCommandError) => {
			if (terminalError || settled) return;
			terminalError = error;
			terminateProcess(child, 'SIGTERM');
			forceKillTimer = setTimeout(() => terminateProcess(child, 'SIGKILL'), 250);
			forceKillTimer.unref();
		};
		const abort = () => terminate(new StatusPluginCommandError(
			'Status plugin command was cancelled.',
			'abort',
			result()
		));
		const timeoutTimer = setTimeout(() => terminate(new StatusPluginCommandError(
			`Status plugin command exceeded ${timeoutMs} ms.`,
			'timeout',
			result()
		)), timeoutMs);
		timeoutTimer.unref();

		const collect = (target: Buffer[], chunk: Buffer) => {
			if (terminalError) return;
			outputBytes += chunk.length;
			if (outputBytes > maxOutputBytes) {
				terminate(new StatusPluginCommandError(
					`Status plugin command exceeded ${maxOutputBytes} output bytes.`,
					'output-limit',
					result()
				));
				return;
			}
			target.push(chunk);
		};
		child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
		child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
		child.once('error', (cause) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(new StatusPluginCommandError('Unable to start status plugin command.', 'spawn', result(), null, { cause }));
		});
		child.once('close', (code) => {
			if (settled) return;
			settled = true;
			cleanup();
			killRemainingProcessGroup(child);
			if (terminalError) {
				terminalError.stdout = result().stdout;
				terminalError.stderr = result().stderr;
				reject(terminalError);
				return;
			}
			if (code !== 0) {
				reject(new StatusPluginCommandError(
					`Status plugin command exited with code ${code ?? 'unknown'}.`,
					'exit',
					result(),
					code
				));
				return;
			}
			resolve(result());
		});
		options.signal?.addEventListener('abort', abort, { once: true });
	});
}
