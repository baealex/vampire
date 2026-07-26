import { execFile as execFileCallback, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { findSessionConnection } from '../src/lib/server/session-state.mjs';

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

async function activePane(tmuxSession) {
	const { stdout } = await execFile('tmux', ['display-message', '-p', '-t', tmuxSession, '#{pane_id}']);
	const paneId = stdout.trim();
	if (!/^%\d+$/.test(paneId)) throw new Error('tmux returned an invalid pane identifier.');
	return paneId;
}

async function sendInput(tmuxSession, data) {
	if (Buffer.byteLength(data) > MAX_INPUT_BYTES) throw new Error('Input is too large.');
	await execFile('tmux', ['send-keys', '-t', tmuxSession, '-l', '--', data]);
}

function tmuxControlBytes(value) {
	const source = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
	const bytes = [];
	for (let index = 0; index < source.length; index += 1) {
		if (
			source[index] === 0x5c
			&& index + 3 < source.length
			&& source[index + 1] >= 0x30 && source[index + 1] <= 0x37
			&& source[index + 2] >= 0x30 && source[index + 2] <= 0x37
			&& source[index + 3] >= 0x30 && source[index + 3] <= 0x37
		) {
			bytes.push(Number.parseInt(source.subarray(index + 1, index + 4).toString('ascii'), 8));
			index += 3;
			continue;
		}
		bytes.push(source[index]);
	}
	return Uint8Array.from(bytes);
}

export function decodeTmuxControlValue(value, decoder = new TextDecoder()) {
	return decoder.decode(tmuxControlBytes(value), { stream: true });
}

export function parseTmuxControlOutput(line, paneId, decoder) {
	const prefix = `%output ${paneId} `;
	if (Buffer.isBuffer(line)) {
		const prefixBytes = Buffer.from(prefix, 'ascii');
		return line.subarray(0, prefixBytes.length).equals(prefixBytes)
			? decodeTmuxControlValue(line.subarray(prefixBytes.length), decoder)
			: undefined;
	}
	return line.startsWith(prefix) ? decodeTmuxControlValue(line.slice(prefix.length), decoder) : undefined;
}

function message(socket, payload) {
	if (socket.readyState === 1) socket.send(JSON.stringify(payload));
}

export async function attachTerminal(socket, sessionId, initialSize, options = {}) {
	const connection = await findSessionConnection(sessionId);
	if (!connection) throw new Error('Unknown Vampire session.');
	const { tmuxSession } = connection;

	const paneId = await activePane(tmuxSession);
	const attachFlags = options.ignoreSize ? ['-f', 'ignore-size'] : [];
	const control = spawn('tmux', ['-C', 'attach-session', ...attachFlags, '-t', tmuxSession], {
		stdio: ['pipe', 'pipe', 'pipe']
	});
	control.stderr.resume();
	let closed = false;
	let snapshotSent = false;
	let snapshotAcknowledged = false;
	let pendingSnapshotOutput = [];
	let pendingSnapshotOutputBytes = 0;
	let attachedResolve;
	let attachedReject;
	const attached = new Promise((resolve, reject) => {
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
	const pendingCommands = [];
	let commandBlock;
	let inputQueue = Promise.resolve();
	let requestedSize;
	let appliedSize;
	let resizing = false;
	let messageWindowStartedAt = Date.now();
	let messageCount = 0;
	let syntheticOutputDepth = 0;
	let syntheticOutputUntil = 0;
	let lastTerminalOutputAt = 0;
	let controlLineBuffer = Buffer.alloc(0);
	const terminalDecoder = new TextDecoder();
	let sizeIgnored = Boolean(options.ignoreSize);

	const rejectControlCommands = (error) => {
		attachedReject(error);
		if (commandBlock?.command) commandBlock.command.reject(error);
		commandBlock = undefined;
		for (const command of pendingCommands.splice(0)) command.reject(error);
	};

	const runControlCommand = (command, onSuccess) => new Promise((resolve, reject) => {
		if (closed || control.exitCode !== null) {
			reject(new Error('tmux control client is unavailable.'));
			return;
		}
		const pending = { resolve, reject, onSuccess, timer: undefined };
		pending.timer = setTimeout(() => {
			pending.reject(new Error('tmux control command timed out.'));
			control.kill();
		}, CONTROL_COMMAND_TIMEOUT_MS);
		pendingCommands.push(pending);
		control.stdin.write(`${command}\n`, (error) => {
			if (!error) return;
			clearTimeout(pending.timer);
			const index = pendingCommands.indexOf(pending);
			if (index >= 0) pendingCommands.splice(index, 1);
			reject(error);
		});
	});

	const withSyntheticOutput = async (operation, settleMs = SYNTHETIC_OUTPUT_SETTLE_MS) => {
		syntheticOutputDepth += 1;
		try {
			return await operation();
		} finally {
			syntheticOutputUntil = Math.max(syntheticOutputUntil, Date.now() + settleMs);
			syntheticOutputDepth -= 1;
		}
	};

	const sendTerminalOutput = (output) => {
		lastTerminalOutputAt = Date.now();
		const activity = snapshotAcknowledged && syntheticOutputDepth === 0 && Date.now() >= syntheticOutputUntil;
		if (!snapshotSent) return;
		if (snapshotAcknowledged) {
			message(socket, { type: 'output', data: output, activity });
			return;
		}

		const bytes = Buffer.byteLength(output);
		if (pendingSnapshotOutputBytes + bytes > MAX_SNAPSHOT_OUTPUT_QUEUE_BYTES) {
			message(socket, { type: 'error', message: 'Terminal output arrived before the screen was ready.' });
			socket.close(1013, 'terminal snapshot fell behind');
			return;
		}
		pendingSnapshotOutput.push({ data: output, activity });
		pendingSnapshotOutputBytes += bytes;
	};

	const acknowledgeSnapshot = () => {
		if (!snapshotSent || snapshotAcknowledged || closed) return;
		snapshotAcknowledged = true;
		const pending = pendingSnapshotOutput;
		pendingSnapshotOutput = [];
		pendingSnapshotOutputBytes = 0;
		for (const output of pending) message(socket, { type: 'output', ...output });
	};

	const handleControlLine = (lineBuffer) => {
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

	control.stdout.on('data', (chunk) => {
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
		pendingSnapshotOutput = [];
		pendingSnapshotOutputBytes = 0;
		controlLineBuffer = Buffer.alloc(0);
		control.stdin.end();
		control.kill();
	});

	const resizeControlClient = async () => {
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

	const setIgnoreSize = async (ignored) => {
		if (closed) return;
		if (sizeIgnored !== ignored) {
			await runControlCommand(`refresh-client -f ${ignored ? 'ignore-size' : '!ignore-size'}`);
			sizeIgnored = ignored;
		}
		if (!ignored) await resizeControlClient();
	};

	const forceTerminalRedraw = async () => {
		if (!appliedSize || closed) return;
		const [columns, rows] = appliedSize.split('x').map(Number);
		const nudgeColumns = columns < 240 ? columns + 1 : columns - 1;
		await withSyntheticOutput(async () => {
			await runControlCommand(`refresh-client -C ${nudgeColumns}x${rows}`);
			if (!closed) await runControlCommand(`refresh-client -C ${appliedSize}`);
			await runControlCommand(SYNTHETIC_OUTPUT_BARRIER);
		}, INITIAL_REDRAW_SETTLE_MS);
	};

	const waitForTerminalRedrawToSettle = async () => {
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
			const input = JSON.parse(raw.toString());
			if (input?.type === 'activate') {
				const activation = options.onActivate?.();
				if (activation) void Promise.resolve(activation).catch((error) => message(socket, {
					type: 'error',
					message: error instanceof Error ? error.message : 'Terminal activation failed.'
				}));
			} else if (input?.type === 'snapshot-ready') {
				acknowledgeSnapshot();
			} else if (input?.type === 'input' && typeof input.data === 'string') {
				inputQueue = inputQueue
					.then(() => sendInput(tmuxSession, input.data))
					.catch((error) => message(socket, {
						type: 'error',
						message: error instanceof Error ? error.message : 'Terminal input failed.'
					}));
			} else if (
				input?.type === 'resize'
				&& Number.isInteger(input.columns)
				&& Number.isInteger(input.rows)
				&& input.columns >= 20
				&& input.columns <= 240
				&& input.rows >= 5
				&& input.rows <= 120
			) {
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
