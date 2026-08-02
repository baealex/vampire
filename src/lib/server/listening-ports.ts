import { execFile as execFileCallback } from 'node:child_process';
import { readlink } from 'node:fs/promises';
import { promisify } from 'node:util';
import type {
	ListeningPort,
	ListeningPortTermination
} from '../system/listening-ports.ts';

const execFile = promisify(execFileCallback);
const COMMAND_TIMEOUT_MS = 3_000;
const COMMAND_MAX_BUFFER_BYTES = 2 * 1024 * 1024;
const WORKING_DIRECTORY_PID_BATCH_SIZE = 100;

export interface ListeningSocket {
	address: string;
	port: number;
	pid: number | null;
	processName: string | null;
}

export type ListeningPortErrorReason =
	| 'unsupported-platform'
	| 'tool-unavailable'
	| 'inspection-failed'
	| 'invalid-request'
	| 'stale'
	| 'protected'
	| 'permission-denied'
	| 'signal-failed';

export class ListeningPortError extends Error {
	readonly reason: ListeningPortErrorReason;

	constructor(reason: ListeningPortErrorReason, message: string) {
		super(message);
		this.name = 'ListeningPortError';
		this.reason = reason;
	}
}

interface CreateListeningPortsOptions {
	currentPid: number;
	workingDirectories?: ReadonlyMap<number, string>;
	processAccess?: (pid: number) => Exclude<ListeningPortTermination, 'protected'>;
}

interface TerminateListeningProcessInput {
	pid: number;
	port: number;
	processName: string | null;
	cwd: string | null;
}

interface TerminateListeningProcessDependencies {
	currentPid?: number;
	list?: () => Promise<ListeningPort[]>;
	signal?: (pid: number, signal: NodeJS.Signals) => void;
}

type CommandRunner = (file: string, args: string[]) => Promise<string>;

function parseEndpoint(value: string): { address: string; port: number } | undefined {
	const separator = value.lastIndexOf(':');
	if (separator < 0) return undefined;
	const port = Number(value.slice(separator + 1));
	if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return undefined;

	let address = value.slice(0, separator);
	if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1);
	if (!address) return undefined;
	return { address, port };
}

function deduplicateSockets(sockets: ListeningSocket[]): ListeningSocket[] {
	const seen = new Set<string>();
	return sockets.filter((socket) => {
		const key = `${socket.pid ?? 'unknown'}\0${socket.processName ?? ''}\0${socket.address}\0${socket.port}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

export function parseLsofListeningSockets(output: string): ListeningSocket[] {
	const sockets: ListeningSocket[] = [];
	let pid: number | null = null;
	let processName: string | null = null;

	for (const field of output.split(/[\0\n]+/)) {
		if (!field) continue;
		const type = field[0];
		const value = field.slice(1);
		if (type === 'p') {
			const parsedPid = Number(value);
			pid = Number.isSafeInteger(parsedPid) && parsedPid > 0 ? parsedPid : null;
			processName = null;
			continue;
		}
		if (type === 'c') {
			processName = value || null;
			continue;
		}
		if (type !== 'n') continue;
		const endpoint = parseEndpoint(value);
		if (!endpoint) continue;
		sockets.push({ ...endpoint, pid, processName });
	}

	return deduplicateSockets(sockets);
}

function unescapeSsProcessName(value: string): string {
	return value.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

export function parseSsListeningSockets(output: string): ListeningSocket[] {
	const sockets: ListeningSocket[] = [];
	for (const line of output.split('\n')) {
		const columns = line.trim().split(/\s+/);
		if (columns.length < 5 || columns[0] !== 'LISTEN') continue;
		const endpoint = parseEndpoint(columns[3] ?? '');
		if (!endpoint) continue;

		const processes = [...line.matchAll(/"((?:\\.|[^"\\])*)",pid=(\d+)/g)];
		if (processes.length === 0) {
			sockets.push({ ...endpoint, pid: null, processName: null });
			continue;
		}

		for (const processMatch of processes) {
			const parsedPid = Number(processMatch[2]);
			if (!Number.isSafeInteger(parsedPid) || parsedPid < 1) continue;
			sockets.push({
				...endpoint,
				pid: parsedPid,
				processName: unescapeSsProcessName(processMatch[1] ?? '') || null
			});
		}
	}
	return deduplicateSockets(sockets);
}

function defaultProcessAccess(pid: number): Exclude<ListeningPortTermination, 'protected'> {
	try {
		process.kill(pid, 0);
		return 'available';
	} catch (cause) {
		return (cause as NodeJS.ErrnoException)?.code === 'ESRCH' ? 'unavailable' : 'permission-denied';
	}
}

export function createListeningPorts(
	sockets: ListeningSocket[],
	options: CreateListeningPortsOptions
): ListeningPort[] {
	const grouped = new Map<string, {
		port: number;
		addresses: Set<string>;
		pid: number | null;
		processName: string | null;
	}>();

	for (const socket of sockets) {
		const key = `${socket.pid ?? 'unknown'}\0${socket.processName ?? ''}\0${socket.port}`;
		const existing = grouped.get(key);
		if (existing) {
			existing.addresses.add(socket.address);
			continue;
		}
		grouped.set(key, {
			port: socket.port,
			addresses: new Set([socket.address]),
			pid: socket.pid,
			processName: socket.processName
		});
	}

	const processAccess = options.processAccess ?? defaultProcessAccess;
	const accessByPid = new Map<number, Exclude<ListeningPortTermination, 'protected'>>();
	const ports = [...grouped.values()].map<ListeningPort>((listener) => {
		let termination: ListeningPortTermination;
		if (listener.pid === null) {
			termination = 'unavailable';
		} else if (listener.pid <= 1 || listener.pid === options.currentPid) {
			termination = 'protected';
		} else {
			const cachedAccess = accessByPid.get(listener.pid);
			termination = cachedAccess ?? processAccess(listener.pid);
			accessByPid.set(listener.pid, termination);
		}

		return {
			protocol: 'tcp',
			port: listener.port,
			addresses: [...listener.addresses].sort(),
			pid: listener.pid,
			processName: listener.processName,
			cwd: listener.pid === null ? null : options.workingDirectories?.get(listener.pid) ?? null,
			termination
		};
	});

	return ports.sort((left, right) =>
		left.port - right.port
		|| (left.processName ?? '').localeCompare(right.processName ?? '')
		|| (left.pid ?? 0) - (right.pid ?? 0)
	);
}

function commandErrorCode(cause: unknown): string | number | undefined {
	return cause && typeof cause === 'object' && 'code' in cause
		? (cause as { code?: string | number }).code
		: undefined;
}

async function runCommand(file: string, args: string[]): Promise<string> {
	try {
		const { stdout } = await execFile(file, args, {
			encoding: 'utf8',
			timeout: COMMAND_TIMEOUT_MS,
			maxBuffer: COMMAND_MAX_BUFFER_BYTES
		});
		return stdout;
	} catch (cause) {
		if (file === 'lsof' && commandErrorCode(cause) === 1) {
			const stdout = cause && typeof cause === 'object' && 'stdout' in cause
				? (cause as { stdout?: unknown }).stdout
				: '';
			return typeof stdout === 'string' ? stdout : '';
		}
		throw cause;
	}
}

async function readListeningSockets(platform: NodeJS.Platform, run: CommandRunner): Promise<ListeningSocket[]> {
	if (platform === 'darwin') {
		return parseLsofListeningSockets(await run('lsof', [
			'-nP',
			'-iTCP',
			'-sTCP:LISTEN',
			'-F0pcPn'
		]));
	}

	if (platform === 'linux') {
		try {
			return parseSsListeningSockets(await run('ss', ['-H', '-ltnp']));
		} catch (cause) {
			if (commandErrorCode(cause) !== 'ENOENT') throw cause;
			return parseLsofListeningSockets(await run('lsof', [
				'-nP',
				'-iTCP',
				'-sTCP:LISTEN',
				'-F0pcPn'
			]));
		}
	}

	throw new ListeningPortError(
		'unsupported-platform',
		'Listening port inspection is available on macOS, Linux, and WSL.'
	);
}

function chunks<T>(items: T[], size: number): T[][] {
	const result: T[][] = [];
	for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
	return result;
}

function parseLsofWorkingDirectories(output: string): Map<number, string> {
	const directories = new Map<number, string>();
	let pid: number | undefined;
	for (const field of output.split(/[\0\n]+/)) {
		if (!field) continue;
		if (field[0] === 'p') {
			const nextPid = Number(field.slice(1));
			pid = Number.isSafeInteger(nextPid) && nextPid > 0 ? nextPid : undefined;
		} else if (field[0] === 'n' && pid !== undefined && field.length > 1) {
			directories.set(pid, field.slice(1));
		}
	}
	return directories;
}

async function readWorkingDirectories(
	platform: NodeJS.Platform,
	pids: number[],
	run: CommandRunner
): Promise<Map<number, string>> {
	const directories = new Map<number, string>();
	if (pids.length === 0) return directories;

	if (platform === 'darwin') {
		for (const batch of chunks(pids, WORKING_DIRECTORY_PID_BATCH_SIZE)) {
			const output = await run('lsof', ['-a', '-p', batch.join(','), '-d', 'cwd', '-F0pn']);
			for (const [pid, cwd] of parseLsofWorkingDirectories(output)) directories.set(pid, cwd);
		}
		return directories;
	}

	if (platform === 'linux') {
		await Promise.all(pids.map(async (pid) => {
			try {
				directories.set(pid, await readlink(`/proc/${pid}/cwd`));
			} catch {
				// Other users' processes commonly hide their working directory.
			}
		}));
	}
	return directories;
}

export async function listListeningPorts(): Promise<ListeningPort[]> {
	const platform = process.platform;
	let sockets: ListeningSocket[];
	try {
		sockets = await readListeningSockets(platform, runCommand);
	} catch (cause) {
		if (cause instanceof ListeningPortError) throw cause;
		if (commandErrorCode(cause) === 'ENOENT') {
			throw new ListeningPortError(
				'tool-unavailable',
				'Vampire could not find lsof or ss to inspect listening ports.'
			);
		}
		throw new ListeningPortError('inspection-failed', 'Vampire could not inspect listening ports.');
	}

	const pids = [...new Set(sockets.flatMap((socket) => socket.pid === null ? [] : [socket.pid]))];
	const workingDirectories = await readWorkingDirectories(platform, pids, runCommand).catch(
		() => new Map<number, string>()
	);
	return createListeningPorts(sockets, {
		currentPid: process.pid,
		workingDirectories
	});
}

export async function terminateListeningProcess(
	input: TerminateListeningProcessInput,
	dependencies: TerminateListeningProcessDependencies = {}
): Promise<void> {
	const currentPid = dependencies.currentPid ?? process.pid;
	if (!Number.isSafeInteger(input.pid) || input.pid <= 1 || input.pid === currentPid) {
		throw new ListeningPortError('protected', 'Vampire will not stop this protected process.');
	}
	if (!Number.isSafeInteger(input.port) || input.port < 1 || input.port > 65_535) {
		throw new ListeningPortError('invalid-request', 'Listening port is invalid.');
	}

	const ports = await (dependencies.list ?? listListeningPorts)();
	const listener = ports.find((port) =>
		port.pid === input.pid
		&& port.port === input.port
		&& port.processName === input.processName
		&& port.cwd === input.cwd
	);
	if (!listener) {
		throw new ListeningPortError(
			'stale',
			'This listening process changed or already ended. Refresh the list and try again.'
		);
	}
	if (listener.termination === 'protected') {
		throw new ListeningPortError('protected', 'Vampire will not stop this protected process.');
	}
	if (listener.termination === 'permission-denied') {
		throw new ListeningPortError(
			'permission-denied',
			'The Vampire server user does not have permission to stop this process.'
		);
	}
	if (listener.termination !== 'available') {
		throw new ListeningPortError(
			'stale',
			'This listening process changed or already ended. Refresh the list and try again.'
		);
	}

	try {
		(dependencies.signal ?? ((pid, signal) => { process.kill(pid, signal); }))(input.pid, 'SIGTERM');
	} catch (cause) {
		const code = (cause as NodeJS.ErrnoException)?.code;
		if (code === 'ESRCH') {
			throw new ListeningPortError('stale', 'This listening process already ended. Refresh the list.');
		}
		if (code === 'EPERM' || code === 'EACCES') {
			throw new ListeningPortError(
				'permission-denied',
				'The Vampire server user does not have permission to stop this process.'
			);
		}
		throw new ListeningPortError('signal-failed', 'Vampire could not signal this process to stop.');
	}
}
