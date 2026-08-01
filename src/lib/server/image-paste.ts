import { execFile as execFileCallback, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { sendTmuxInput } from './tmux.ts';

const execFile = promisify(execFileCallback);
const IMAGE_CONVERSION_TIMEOUT_MS = 8_000;
const CLIPBOARD_TIMEOUT_MS = 8_000;

export const MAX_IMAGE_PASTE_BYTES = 10 * 1024 * 1024;
export const SUPPORTED_IMAGE_TYPES = new Set([
	'image/avif',
	'image/gif',
	'image/jpeg',
	'image/png',
	'image/webp'
]);

export type ImagePasteErrorReason = 'unsupported-platform' | 'clipboard-unavailable' | 'clipboard-failed';

export class ImagePasteError extends Error {
	readonly reason: ImagePasteErrorReason;

	constructor(reason: ImagePasteErrorReason, message: string) {
		super(message);
		this.reason = reason;
	}
}

function appleScriptString(value: string): string {
	return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function extensionForMimeType(mimeType: string): string {
	return {
		'image/avif': '.avif',
		'image/gif': '.gif',
		'image/jpeg': '.jpg',
		'image/png': '.png',
		'image/webp': '.webp'
	}[mimeType] ?? '.img';
}

function runWithStdin(command: string, args: string[], input: Buffer, timeout: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'pipe'] });
		let stderr = '';
		let settled = false;
		const timer = setTimeout(() => {
			child.kill('SIGTERM');
			finish(new Error(`${command} timed out.`));
		}, timeout);

		const finish = (cause?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (cause) reject(cause);
			else resolve();
		};

		child.stderr.on('data', (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.once('error', (cause: NodeJS.ErrnoException) => {
			finish(cause.code === 'ENOENT' ? new Error(`${command} is not installed.`) : cause);
		});
		child.once('exit', (code, signal) => {
			if (code === 0) finish();
			else finish(new Error(stderr.trim() || `${command} exited with ${signal ?? `code ${code}`}.`));
		});
		child.stdin.end(input);
	});
}

async function writeMacClipboard(sourcePath: string, mimeType: string, directory: string): Promise<void> {
	const pngPath = join(directory, 'clipboard.png');
	if (mimeType === 'image/png') {
		await writeFile(pngPath, await readFile(sourcePath), { mode: 0o600 });
	} else {
		try {
			await execFile('sips', ['-s', 'format', 'png', sourcePath, '--out', pngPath], {
				timeout: IMAGE_CONVERSION_TIMEOUT_MS,
				maxBuffer: 32 * 1024
			});
		} catch {
			throw new ImagePasteError('clipboard-failed', 'macOS could not convert that image to clipboard format.');
		}
	}

	try {
		await execFile('osascript', [
			'-e',
			`set the clipboard to (read POSIX file ${appleScriptString(pngPath)} as «class PNGf»)`
		], { timeout: CLIPBOARD_TIMEOUT_MS, maxBuffer: 32 * 1024 });
	} catch {
		throw new ImagePasteError('clipboard-unavailable', 'macOS could not access the host clipboard.');
	}
}

async function writeLinuxClipboard(bytes: Buffer, mimeType: string): Promise<void> {
	try {
		await runWithStdin('wl-copy', ['--type', mimeType], bytes, CLIPBOARD_TIMEOUT_MS);
		return;
	} catch (cause) {
		if (!(cause instanceof Error) || !cause.message.includes('not installed')) {
			throw new ImagePasteError('clipboard-failed', 'The Linux Wayland clipboard rejected the image.');
		}
	}

	try {
		await runWithStdin('xclip', ['-selection', 'clipboard', '-t', mimeType, '-i'], bytes, CLIPBOARD_TIMEOUT_MS);
	} catch {
		throw new ImagePasteError('clipboard-unavailable', 'Install wl-copy or xclip to enable image pasting on Linux.');
	}
}

async function writeImageToHostClipboard(bytes: Buffer, mimeType: string, directory: string): Promise<void> {
	const sourcePath = join(directory, `image${extensionForMimeType(mimeType)}`);
	await writeFile(sourcePath, bytes, { mode: 0o600 });

	if (process.platform === 'darwin') {
		await writeMacClipboard(sourcePath, mimeType, directory);
		return;
	}
	if (process.platform === 'linux') {
		await writeLinuxClipboard(bytes, mimeType);
		return;
	}
	throw new ImagePasteError('unsupported-platform', 'Image pasting is currently supported on macOS and Linux hosts.');
}

let pasteQueue: Promise<void> = Promise.resolve();

export function pasteImageToSession(input: { tmuxTarget: string; bytes: Buffer; mimeType: string }): Promise<void> {
	const operation = pasteQueue.then(async () => {
		const directory = await mkdtemp(join(tmpdir(), 'vampire-image-'));
		try {
			await writeImageToHostClipboard(input.bytes, input.mimeType, directory);
			await sendTmuxInput(input.tmuxTarget, '\u0016');
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	pasteQueue = operation.catch(() => undefined);
	return operation;
}
