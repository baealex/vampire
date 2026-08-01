import { execFile as execFileCallback, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import WebSocket from 'ws';

import { findSessionConnection } from '../src/lib/server/session-store.ts';
import {
	decodeTerminalClientMessage,
	encodeTerminalServerMessage,
	type TerminalServerMessage
} from '../src/lib/terminal/protocol.ts';
import { decodeTmuxControlValue, parseTmuxControlOutput } from './tmux-control.ts';

export { decodeTmuxControlValue, parseTmuxControlOutput } from './tmux-control.ts';

const execFile = promisify(execFileCallback);
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_MESSAGES_PER_WINDOW = 600;
const MESSAGE_WINDOW_MS = 10_000;
const CONTROL_COMMAND_TIMEOUT_MS = 3_000;
const MAX_SNAPSHOT_OUTPUT_QUEUE_BYTES = 512 * 1024;
const SYNTHETIC_OUTPUT_SETTLE_MS = 150;
const INITIAL_REDRAW_SETTLE_MS = 1_000;
const INITIAL_REDRAW_MINIMUM_MS = 500;
const INITIAL_REDRAW_QUIET_MS = 160;
const INITIAL_REDRAW_MAXIMUM_MS = 1_500;
const SYNTHETIC_OUTPUT_BARRIER = 'display-message -p vampire-redraw-barrier';

export interface TerminalSize {
	columns: number;
	rows: number;
}

export type TerminalSizeController = (ignored: boolean) => Promise<void>;

export interface AttachTerminalOptions {
	terminalId?: string;
	ignoreSize?: boolean;
	canResize?: () => boolean;
	onAttached?: (setIgnoreSize: TerminalSizeController) => Promise<void> | void;
	onActivate?: () => Promise<void> | void;
	onSyntheticOutput?: (timestamp: number) => void;
	isOutputActivity?: (timestamp: number) => boolean;
	onOutputActivity?: (timestamp: number) => void;
}

interface OutputActivityState {
	snapshotAcknowledged: boolean;
	syntheticOutputDepth: number;
	syntheticOutputUntil: number;
	sharedOutputAllowed?: boolean;
}

interface QueuedOutput {
	data: string;
	activity: boolean;
	activityAt: number | null;
}

interface PendingControlCommand {
	resolve: (output: string) => void;
	reject: (reason: unknown) => void;
	onSuccess?: (output: string) => void;
	timer: NodeJS.Timeout;
}

interface ControlCommandBlock {
	command: PendingControlCommand | undefined;
	output: string[];
}

async function terminalTarget(tmuxSession: string, requestedWindowId?: string): Promise<{ windowId: string; paneId: string }> {
	if (requestedWindowId !== undefined && !/^@\d+$/.test(requestedWindowId)) {
		throw new Error('Terminal identifier is invalid.');
	}
	const target = requestedWindowId ?? tmuxSession;
	const { stdout } = await execFile('tmux', [
		'display-message',
		'-p',
		'-t',
		target,
		'#{session_name}\t#{window_id}\t#{pane_id}'
	]);
	const [sessionName, windowId, paneId] = stdout.trim().split('\t');
	if (sessionName !== tmuxSession || !/^@\d+$/.test(windowId ?? '') || !/^%\d+$/.test(paneId ?? '')) {
		throw new Error('Terminal does not belong to this workspace.');
	}
	if (requestedWindowId !== undefined && windowId !== requestedWindowId) {
		throw new Error('Terminal does not belong to this workspace.');
	}
	return { windowId, paneId };
}

async function sendInput(paneId: string, data: string): Promise<void> {
	if (Buffer.byteLength(data) > MAX_INPUT_BYTES) throw new Error('Input is too large.');
	await execFile('tmux', ['send-keys', '-t', paneId, '-l', '--', data]);
}

export function isTerminalOutputActivity({
	snapshotAcknowledged,
	syntheticOutputDepth,
	syntheticOutputUntil,
	sharedOutputAllowed = true
}: OutputActivityState, timestamp: number): boolean {
	return snapshotAcknowledged
		&& syntheticOutputDepth === 0
		&& timestamp >= syntheticOutputUntil
		&& sharedOutputAllowed;
}

function message(socket: WebSocket, payload: TerminalServerMessage): void {
	if (socket.readyState === 1) socket.send(encodeTerminalServerMessage(payload));
}

export async function attachTerminal(
	socket: WebSocket,
	sessionId: string,
	initialSize: TerminalSize | undefined,
	options: AttachTerminalOptions = {}
): Promise<void> {
	const connection = await findSessionConnection(sessionId);
	if (!connection) throw new Error('Unknown Vampire session.');
	const { tmuxSession } = connection;

	const { windowId, paneId } = await terminalTarget(tmuxSession, options.terminalId);
	options.onSyntheticOutput?.(Date.now() + INITIAL_REDRAW_SETTLE_MS);
	const attachFlags = options.ignoreSize ? ['-f', 'ignore-size'] : [];
	const control = spawn('tmux', ['-C', 'attach-session', ...attachFlags, '-t', windowId], {
		stdio: ['pipe', 'pipe', 'pipe']
	});
	control.stderr.resume();
	let closed = false;
	let snapshotSent = false;
	let snapshotAcknowledged = false;
	let pendingSnapshotOutput: QueuedOutput[] = [];
	let pendingSnapshotOutputBytes = 0;
	let attachedResolve!: () => void;
	let attachedReject!: (reason: unknown) => void;
	const attached = new Promise<void>((resolve, reject) => {
		attachedResolve = resolve;
		attachedReject = reject;
	});
	const attachmentTimer = setTimeout(() => {
		attachedReject(new Error('tmux control client did not attach in time.'));
		control.kill();
	}, CONTROL_COMMAND_TIMEOUT_MS);
	void attached.then(
		() => clearTimeout(attachmentTimer),
		() => clearTimeout(attachmentTimer)
	);
	const pendingCommands: PendingControlCommand[] = [];
	let commandBlock: ControlCommandBlock | undefined;
	let inputQueue: Promise<void> = Promise.resolve();
	let requestedSize: TerminalSize | undefined;
	let appliedSize: string | undefined;
	let resizing = false;
	let messageWindowStartedAt = Date.now();
	let messageCount = 0;
	let syntheticOutputDepth = 0;
	let syntheticOutputUntil = 0;
	let lastTerminalOutputAt = 0;
	let lastOutputActivityNotice = 0;
	let controlLineBuffer = Buffer.alloc(0);
	const terminalDecoder = new TextDecoder();
	let sizeIgnored = Boolean(options.ignoreSize);

	const rejectControlCommands = (error: unknown): void => {
		attachedReject(error);
		if (commandBlock?.command) commandBlock.command.reject(error);
		commandBlock = undefined;
		for (const command of pendingCommands.splice(0)) command.reject(error);
	};

	const runControlCommand = (command: string, onSuccess?: (output: string) => void): Promise<string> => new Promise((resolve, reject) => {
		if (closed || control.exitCode !== null) {
			reject(new Error('tmux control client is unavailable.'));
			return;
		}
		const pending: PendingControlCommand = {
			resolve,
			reject,
			onSuccess,
			timer: setTimeout(() => {
				pending.reject(new Error('tmux control command timed out.'));
				control.kill();
			}, CONTROL_COMMAND_TIMEOUT_MS)
		};
		pendingCommands.push(pending);
		control.stdin.write(`${command}\n`, (error) => {
			if (!error) return;
			clearTimeout(pending.timer);
			const index = pendingCommands.indexOf(pending);
			if (index >= 0) pendingCommands.splice(index, 1);
			reject(error);
		});
	});

	const withSyntheticOutput = async <T>(operation: () => Promise<T>, settleMs = SYNTHETIC_OUTPUT_SETTLE_MS): Promise<T> => {
		syntheticOutputDepth += 1;
		options.onSyntheticOutput?.(Date.now() + settleMs);
		try {
			return await operation();
		} finally {
			syntheticOutputUntil = Math.max(syntheticOutputUntil, Date.now() + settleMs);
			options.onSyntheticOutput?.(syntheticOutputUntil);
			syntheticOutputDepth -= 1;
		}
	};

	const sendTerminalOutput = (output: string): void => {
		const now = Date.now();
		lastTerminalOutputAt = now;
		const locallyEligible = snapshotAcknowledged && syntheticOutputDepth === 0 && now >= syntheticOutputUntil;
		const activity = isTerminalOutputActivity({
			snapshotAcknowledged,
			syntheticOutputDepth,
			syntheticOutputUntil,
			sharedOutputAllowed: !locallyEligible || options.isOutputActivity?.(now) !== false
		}, now);
		const activityAt = activity ? now : null;
		if (activity && now - lastOutputActivityNotice >= 250) {
			lastOutputActivityNotice = now;
			options.onOutputActivity?.(now);
		}
		if (!snapshotSent) return;
		if (snapshotAcknowledged) {
			message(socket, { type: 'output', data: output, activity, activityAt });
			return;
		}

		const bytes = Buffer.byteLength(output);
		if (pendingSnapshotOutputBytes + bytes > MAX_SNAPSHOT_OUTPUT_QUEUE_BYTES) {
			message(socket, { type: 'error', message: 'Terminal output arrived before the screen was ready.' });
			socket.close(1013, 'terminal snapshot fell behind');
			return;
		}
		pendingSnapshotOutput.push({ data: output, activity, activityAt });
		pendingSnapshotOutputBytes += bytes;
	};

	const acknowledgeSnapshot = (): void => {
		if (!snapshotSent || snapshotAcknowledged || closed) return;
		snapshotAcknowledged = true;
		const pending = pendingSnapshotOutput;
		pendingSnapshotOutput = [];
		pendingSnapshotOutputBytes = 0;
		for (const output of pending) message(socket, { type: 'output', ...output });
	};

	const handleControlLine = (lineBuffer: Buffer): void => {
		const output = parseTmuxControlOutput(lineBuffer, paneId, terminalDecoder);
		if (output !== undefined) {
			sendTerminalOutput(output);
			return;
		}
		const line = lineBuffer.toString('utf8');
		if (line.startsWith('%begin ')) {
			commandBlock = { command: pendingCommands.shift(), output: [] };
			return;
		}
		if (commandBlock) {
			if (line.startsWith('%end ') || line.startsWith('%error ')) {
				const completed = commandBlock;
				commandBlock = undefined;
				if (!completed.command) return;
				clearTimeout(completed.command.timer);
				if (line.startsWith('%error ')) {
					completed.command.reject(new Error(completed.output.join('\n') || 'tmux command failed.'));
					return;
				}
				const output = completed.output.length > 0 ? `${completed.output.join('\n')}\n` : '';
				try {
					completed.command.onSuccess?.(output);
					completed.command.resolve(output);
				} catch (error) {
					completed.command.reject(error);
				}
				return;
			}
			commandBlock.output.push(line);
			return;
		}
		if (line.startsWith('%session-changed ')) attachedResolve();
	};

	control.stdout.on('data', (chunk: Buffer) => {
		const buffer = controlLineBuffer.length > 0 ? Buffer.concat([controlLineBuffer, chunk]) : chunk;
		let lineStart = 0;
		for (let index = 0; index < buffer.length; index += 1) {
			if (buffer[index] !== 0x0a) continue;
			handleControlLine(buffer.subarray(lineStart, index));
			lineStart = index + 1;
		}
		controlLineBuffer = lineStart === buffer.length ? Buffer.alloc(0) : Buffer.from(buffer.subarray(lineStart));
	});

	control.once('error', (error) => {
		rejectControlCommands(error);
		if (!closed) message(socket, { type: 'error', message: 'Could not attach to the tmux session.' });
	});
	control.once('exit', () => {
		rejectControlCommands(new Error('tmux control client exited.'));
		if (!closed) {
			message(socket, { type: 'error', message: 'The tmux session is no longer available.' });
			socket.close(1011, 'tmux session unavailable');
		}
	});
	socket.once('close', () => {
		closed = true;
		options.onSyntheticOutput?.(Date.now() + SYNTHETIC_OUTPUT_SETTLE_MS);
		pendingSnapshotOutput = [];
		pendingSnapshotOutputBytes = 0;
		controlLineBuffer = Buffer.alloc(0);
		control.stdin.end();
		control.kill();
	});

	const resizeControlClient = async (): Promise<void> => {
		if (resizing || closed || options.canResize?.() === false) return;
		resizing = true;
		try {
			while (requestedSize && !closed && options.canResize?.() !== false) {
				const next = requestedSize;
				requestedSize = undefined;
				const key = `${next.columns}x${next.rows}`;
				if (key === appliedSize) continue;
				await withSyntheticOutput(async () => {
					await runControlCommand(`refresh-client -C ${key}`);
					await runControlCommand(SYNTHETIC_OUTPUT_BARRIER);
				});
				appliedSize = key;
			}
		} catch (error) {
			message(socket, { type: 'error', message: error instanceof Error ? error.message : 'Terminal resize failed.' });
		} finally {
			resizing = false;
			if (requestedSize && !closed) void resizeControlClient();
		}
	};

	const setIgnoreSize = async (ignored: boolean): Promise<void> => {
		if (closed) return;
		if (sizeIgnored !== ignored) {
			await withSyntheticOutput(() => runControlCommand(`refresh-client -f ${ignored ? 'ignore-size' : '!ignore-size'}`));
			sizeIgnored = ignored;
		}
		if (!ignored) await resizeControlClient();
	};

	const forceTerminalRedraw = async (): Promise<void> => {
		if (!appliedSize || closed) return;
		const [columns, rows] = appliedSize.split('x').map(Number);
		const nudgeColumns = columns < 240 ? columns + 1 : columns - 1;
		await withSyntheticOutput(async () => {
			await runControlCommand(`refresh-client -C ${nudgeColumns}x${rows}`);
			if (!closed) await runControlCommand(`refresh-client -C ${appliedSize}`);
			await runControlCommand(SYNTHETIC_OUTPUT_BARRIER);
		}, INITIAL_REDRAW_SETTLE_MS);
	};

	const waitForTerminalRedrawToSettle = async (): Promise<void> => {
		const startedAt = Date.now();
		while (!closed) {
			const now = Date.now();
			const elapsed = now - startedAt;
			const quietFor = now - lastTerminalOutputAt;
			if (elapsed >= INITIAL_REDRAW_MINIMUM_MS && quietFor >= INITIAL_REDRAW_QUIET_MS) return;
			if (elapsed >= INITIAL_REDRAW_MAXIMUM_MS) return;
			await new Promise((resolve) => setTimeout(resolve, 40));
		}
	};

	socket.on('message', (raw, isBinary) => {
		if (isBinary || closed) return;
		const now = Date.now();
		if (now - messageWindowStartedAt >= MESSAGE_WINDOW_MS) {
			messageWindowStartedAt = now;
			messageCount = 0;
		}
		messageCount += 1;
		if (messageCount > MAX_MESSAGES_PER_WINDOW) {
			socket.close(1008, 'message rate exceeded');
			return;
		}

		try {
			const input = decodeTerminalClientMessage(raw);
			if (!input) throw new Error('Terminal input is invalid.');
			if (input.type === 'activate') {
				const activation = options.onActivate?.();
				if (activation) void Promise.resolve(activation).catch((error) => message(socket, {
					type: 'error',
					message: error instanceof Error ? error.message : 'Terminal activation failed.'
				}));
			} else if (input.type === 'snapshot-ready') {
				acknowledgeSnapshot();
			} else if (input.type === 'input') {
				if (syntheticOutputDepth === 0) syntheticOutputUntil = 0;
				inputQueue = inputQueue
					.then(() => sendInput(paneId, input.data))
					.catch((error) => message(socket, {
						type: 'error',
						message: error instanceof Error ? error.message : 'Terminal input failed.'
					}));
			} else if (input.type === 'resize') {
				requestedSize = { columns: input.columns, rows: input.rows };
				void resizeControlClient();
			}
		} catch (error) {
			message(socket, { type: 'error', message: error instanceof Error ? error.message : 'Terminal input failed.' });
		}
	});

	await attached;
	if (initialSize) requestedSize = initialSize;
	await options.onAttached?.(setIgnoreSize);
	if (requestedSize) await resizeControlClient();
	await runControlCommand(`capture-pane -p -e -S - -t ${paneId}`, (snapshot) => {
		snapshotSent = true;
		message(socket, { type: 'snapshot', data: snapshot });
	});
	if (appliedSize) {
		lastTerminalOutputAt = Date.now();
		await forceTerminalRedraw();
		await waitForTerminalRedrawToSettle();
	}
	message(socket, { type: 'screen-ready' });
	if (requestedSize) void resizeControlClient();
}
