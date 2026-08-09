import { execFile as execFileCallback, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import WebSocket from 'ws';

import { findSessionConnection } from '../src/lib/server/session-store.ts';
import {
	decodeTerminalClientMessage,
	encodeTerminalServerMessage,
	TERMINAL_GEOMETRY_LIMITS,
	TERMINAL_SCROLLBACK_LINES,
	type TerminalServerMessage
} from '../src/lib/terminal/protocol.ts';
import {
	terminalColorReport,
	type TerminalColorSlot
} from '../src/lib/terminal/color-report.ts';
import { decodeTmuxControlValue, parseTmuxControlOutput } from './tmux-control.ts';

export { decodeTmuxControlValue, parseTmuxControlOutput } from './tmux-control.ts';

const execFile = promisify(execFileCallback);
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_PENDING_INPUT_BYTES = 256 * 1024;
const TMUX_INPUT_CHUNK_BYTES = 4 * 1024;
const MAX_MESSAGES_PER_WINDOW = 600;
const MESSAGE_WINDOW_MS = 10_000;
const CONTROL_COMMAND_TIMEOUT_MS = 3_000;
const BRACKETED_SUBMIT_SETTLE_MS = 20;
const UNBRACKETED_SUBMIT_SETTLE_MS = 140;
const MAX_SNAPSHOT_OUTPUT_QUEUE_BYTES = 512 * 1024;
const SYNTHETIC_OUTPUT_SETTLE_MS = 150;
const TERMINAL_RESIZE_SETTLE_MS = 1_000;
const SYNTHETIC_OUTPUT_BARRIER = 'display-message -p vampire-redraw-barrier';

export interface TerminalSize {
	columns: number;
	rows: number;
}

export type TerminalSizeController = (ignored: boolean) => Promise<void>;

export interface AttachTerminalOptions {
	terminalId?: string;
	historyLines?: number;
	ignoreSize?: boolean;
	canResize?: () => boolean;
	canReportTerminalColor?: () => boolean;
	getGeometry?: () => TerminalSize | undefined;
	sendGeometry?: boolean;
	onAttached?: (setIgnoreSize: TerminalSizeController) => Promise<void> | void;
	onActivate?: () => Promise<void> | void;
	onGeometryChange?: (geometry: TerminalSize) => void;
	onInput?: () => void;
	onSyntheticActivity?: (timestamp: number) => void;
	onSyntheticOutput?: (timestamp: number) => void;
	isOutputActivity?: (timestamp: number) => boolean;
	onOutputActivity?: (timestamp: number) => void;
}

export function terminalSnapshotHistoryLines(requested?: number): number {
	if (!Number.isInteger(requested) || Number(requested) <= 0) return TERMINAL_SCROLLBACK_LINES.standard;
	return Math.min(TERMINAL_SCROLLBACK_LINES.standard, Number(requested));
}

export function* terminalInputControlCommands(paneId: string, data: string): Generator<string> {
	if (!/^%\d+$/.test(paneId)) throw new Error('Terminal pane identifier is invalid.');
	const input = Buffer.from(data);
	for (let offset = 0; offset < input.length; offset += TMUX_INPUT_CHUNK_BYTES) {
		const chunk = input.subarray(offset, offset + TMUX_INPUT_CHUNK_BYTES);
		const bytes = Array.from(chunk, (byte) => byte.toString(16).padStart(2, '0')).join(' ');
		yield `send-keys -H -t ${paneId} ${bytes}`;
	}
}

export function terminalColorControlCommand(
	paneId: string,
	slot: TerminalColorSlot,
	color: string
): string {
	if (!/^%\d+$/.test(paneId)) throw new Error('Terminal pane identifier is invalid.');
	// Control mode clients report terminal replies through refresh-client, not pane keyboard input.
	return `refresh-client -r '${paneId}:${terminalColorReport(slot, color)}'`;
}

export function tmuxSupportsTerminalColorReports(commandList: string): boolean {
	return commandList.split(/\r?\n/).some((line) =>
		/^refresh-client(?:\s|\()/.test(line) && /\[-r(?:\s|\])/.test(line)
	);
}

export function terminalActivityTimestamp(output: string): number | undefined {
	const value = output.trim();
	if (!/^\d+$/.test(value)) return undefined;
	const milliseconds = Number(value) * 1_000;
	return Number.isSafeInteger(milliseconds) && milliseconds > 0 ? milliseconds : undefined;
}

export function terminalSubmissionData(data: string, bracketedPaste: boolean): string {
	const normalized = data.replace(/\r?\n/g, '\r');
	return bracketedPaste ? `\u001b[200~${normalized}\u001b[201~` : normalized;
}

export function terminalSubmissionSettleMs(bracketedPaste: boolean): number {
	return bracketedPaste ? BRACKETED_SUBMIT_SETTLE_MS : UNBRACKETED_SUBMIT_SETTLE_MS;
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

async function terminalTarget(
	tmuxSession: string,
	requestedWindowId?: string
): Promise<{ windowId: string; paneId: string; geometry: TerminalSize }> {
	if (requestedWindowId !== undefined && !/^@\d+$/.test(requestedWindowId)) {
		throw new Error('Terminal identifier is invalid.');
	}
	const target = requestedWindowId ?? tmuxSession;
	const { stdout } = await execFile('tmux', [
		'display-message',
		'-p',
		'-t',
		target,
		'#{session_name}\t#{window_id}\t#{pane_id}\t#{pane_width}\t#{pane_height}'
	]);
	const [sessionName, windowId, paneId, rawColumns, rawRows] = stdout.trim().split('\t');
	const columns = Number(rawColumns);
	const rows = Number(rawRows);
	if (sessionName !== tmuxSession || !/^@\d+$/.test(windowId ?? '') || !/^%\d+$/.test(paneId ?? '')) {
		throw new Error('Terminal does not belong to this workspace.');
	}
	if (requestedWindowId !== undefined && windowId !== requestedWindowId) {
		throw new Error('Terminal does not belong to this workspace.');
	}
	if (
		!Number.isInteger(columns)
		|| columns < TERMINAL_GEOMETRY_LIMITS.minimumColumns
		|| columns > TERMINAL_GEOMETRY_LIMITS.maximumColumns
		|| !Number.isInteger(rows)
		|| rows < TERMINAL_GEOMETRY_LIMITS.minimumRows
		|| rows > TERMINAL_GEOMETRY_LIMITS.maximumRows
	) throw new Error('Terminal geometry is invalid.');
	return { windowId, paneId, geometry: { columns, rows } };
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
	const snapshotHistoryLines = terminalSnapshotHistoryLines(options.historyLines);

	const { windowId, paneId, geometry: targetGeometry } = await terminalTarget(tmuxSession, options.terminalId);
	options.onGeometryChange?.(targetGeometry);
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
	let pendingInputBytes = 0;
	let requestedSize: TerminalSize | undefined = initialSize;
	let appliedSize: string | undefined;
	let currentGeometry = targetGeometry;
	let resizing = false;
	let messageWindowStartedAt = Date.now();
	let messageCount = 0;
	let syntheticOutputDepth = 0;
	let syntheticOutputUntil = 0;
	let lastOutputActivityNotice = 0;
	let controlLineBuffer = Buffer.alloc(0);
	const terminalDecoder = new TextDecoder();
	let sizeIgnored = Boolean(options.ignoreSize);

	const rejectControlCommands = (error: unknown): void => {
		attachedReject(error);
		if (commandBlock?.command) {
			clearTimeout(commandBlock.command.timer);
			commandBlock.command.reject(error);
		}
		commandBlock = undefined;
		for (const command of pendingCommands.splice(0)) {
			clearTimeout(command.timer);
			command.reject(error);
		}
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
	let terminalColorReportSupport: Promise<boolean> | undefined;
	const supportsTerminalColorReports = (): Promise<boolean> => {
		terminalColorReportSupport ??= runControlCommand('list-commands')
			.then(tmuxSupportsTerminalColorReports)
			.catch(() => false);
		return terminalColorReportSupport;
	};

	const sendControlInput = async (data: string): Promise<void> => {
		for (const command of terminalInputControlCommands(paneId, data)) {
			await runControlCommand(command);
		}
	};

	const sendTerminalSubmission = async (data: string, bracketedPaste: boolean): Promise<void> => {
		await sendControlInput(terminalSubmissionData(data, bracketedPaste));
		if (closed) return;
		await new Promise((resolve) => setTimeout(resolve, terminalSubmissionSettleMs(bracketedPaste)));
		if (!closed) await runControlCommand(`send-keys -t ${paneId} Enter`);
	};

	const queueTerminalInput = (data: string, operation: () => Promise<void>): void => {
		const bytes = Buffer.byteLength(data);
		if (bytes > MAX_INPUT_BYTES) throw new Error('Input is too large.');
		if (pendingInputBytes + bytes > MAX_PENDING_INPUT_BYTES) {
			message(socket, { type: 'error', message: 'Terminal input was paused because the server fell behind.' });
			socket.close(1013, 'terminal input fell behind');
			return;
		}
		pendingInputBytes += bytes;
		if (syntheticOutputDepth === 0) syntheticOutputUntil = 0;
		inputQueue = inputQueue
			.then(operation)
			.catch((error) => message(socket, {
				type: 'error',
				message: error instanceof Error ? error.message : 'Terminal input failed.'
			}))
			.finally(() => {
				pendingInputBytes -= bytes;
			});
	};

	const withSyntheticOutput = async <T>(operation: () => Promise<T>, settleMs = SYNTHETIC_OUTPUT_SETTLE_MS): Promise<T> => {
		syntheticOutputDepth += 1;
		options.onSyntheticOutput?.(Date.now() + settleMs);
		try {
			return await operation();
		} finally {
			try {
				const activity = terminalActivityTimestamp(await runControlCommand(
					`display-message -p -t ${windowId} '#{window_activity}'`
				));
				if (activity !== undefined) options.onSyntheticActivity?.(activity);
			} catch {
				// Activity classification must not turn a successful terminal resize into an error.
			}
			syntheticOutputUntil = Math.max(syntheticOutputUntil, Date.now() + settleMs);
			options.onSyntheticOutput?.(syntheticOutputUntil);
			syntheticOutputDepth -= 1;
		}
	};

	const sendTerminalOutput = (output: string): void => {
		const now = Date.now();
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
		if (resizing || closed || sizeIgnored || options.canResize?.() === false) return;
		resizing = true;
		try {
			while (requestedSize && !closed && options.canResize?.() !== false) {
				const next = requestedSize;
				requestedSize = undefined;
				const key = `${next.columns}x${next.rows}`;
				if (key === appliedSize) continue;
				const previousGeometry = currentGeometry;
				currentGeometry = next;
				options.onGeometryChange?.(next);
				try {
					await withSyntheticOutput(async () => {
						await runControlCommand(`refresh-client -C ${key}`);
						await runControlCommand(SYNTHETIC_OUTPUT_BARRIER);
					}, TERMINAL_RESIZE_SETTLE_MS);
					appliedSize = key;
				} catch (error) {
					currentGeometry = previousGeometry;
					options.onGeometryChange?.(previousGeometry);
					throw error;
				}
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
		if (!ignored && sizeIgnored) {
			while (requestedSize && !closed) {
				const next = requestedSize;
				requestedSize = undefined;
				const key = `${next.columns}x${next.rows}`;
				if (key === appliedSize) continue;
				await runControlCommand(`refresh-client -C ${key}`);
				appliedSize = key;
				currentGeometry = next;
			}
			// Announce the geometry before tmux emits the redraw caused by this client
			// becoming authoritative, so every browser renders the same grid.
			options.onGeometryChange?.(currentGeometry);
			await withSyntheticOutput(
				() => runControlCommand('refresh-client -f !ignore-size'),
				TERMINAL_RESIZE_SETTLE_MS
			);
			sizeIgnored = false;
		} else if (ignored && !sizeIgnored) {
			await withSyntheticOutput(() => runControlCommand('refresh-client -f ignore-size'));
			sizeIgnored = true;
		}
		if (!ignored) await resizeControlClient();
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
				queueTerminalInput('', async () => {
					await options.onActivate?.();
				});
			} else if (input.type === 'snapshot-ready') {
				acknowledgeSnapshot();
			} else if (input.type === 'input') {
				queueTerminalInput(input.data, async () => {
					await options.onActivate?.();
					options.onInput?.();
					await sendControlInput(input.data);
				});
			} else if (input.type === 'terminal-color') {
				queueTerminalInput(input.color, async () => {
					await attached;
					if (options.canReportTerminalColor?.() === false) return;
					if (!(await supportsTerminalColorReports())) return;
					if (options.canReportTerminalColor?.() === false) return;
					await runControlCommand(terminalColorControlCommand(paneId, input.slot, input.color));
				});
			} else if (input.type === 'submit') {
				queueTerminalInput(input.data, async () => {
					await options.onActivate?.();
					options.onInput?.();
					await sendTerminalSubmission(input.data, input.bracketedPaste);
				});
			} else if (input.type === 'resize') {
				requestedSize = { columns: input.columns, rows: input.rows };
				queueTerminalInput('', resizeControlClient);
			}
		} catch (error) {
			message(socket, { type: 'error', message: error instanceof Error ? error.message : 'Terminal input failed.' });
		}
	});

	await attached;
	await options.onAttached?.(setIgnoreSize);
	if (requestedSize) await resizeControlClient();
	const snapshotGeometry = options.getGeometry?.() ?? currentGeometry;
	if (options.sendGeometry) message(socket, { type: 'geometry', ...snapshotGeometry });
	await runControlCommand(`capture-pane -p -e -S -${snapshotHistoryLines} -t ${paneId}`, (snapshot) => {
		snapshotSent = true;
		message(socket, { type: 'snapshot', data: snapshot });
	});
	message(socket, { type: 'screen-ready' });
	if (requestedSize) void resizeControlClient();
}
