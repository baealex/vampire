import { execFile as execFileCallback } from 'node:child_process';
import { setTimeout as waitForTimeout } from 'node:timers/promises';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const PROCESS_TABLE_MAX_BUFFER = 2 * 1024 * 1024;
const PROCESS_EXIT_POLL_INTERVAL_MS = 100;
const GRACEFUL_EXIT_POLL_ATTEMPTS = 15;
const FORCED_EXIT_POLL_ATTEMPTS = 5;

export interface ProcessRecord {
	pid: number;
	ppid: number;
	pgid: number;
	tpgid: number;
	tty?: string;
	state?: string;
	command: string;
}

export interface ProcessTerminationDependencies {
	readProcesses: () => Promise<Map<number, ProcessRecord>>;
	signalProcessGroup: (processGroupId: number, signal: NodeJS.Signals) => void;
	wait: (durationMs: number) => Promise<void>;
}

export function parseProcessTable(output: string): Map<number, ProcessRecord> {
	const processes = new Map<number, ProcessRecord>();
	for (const line of output.split('\n')) {
		const fields = line.trim().split(/\s+/);
		if (fields.length < 7) continue;
		const [pid, ppid, pgid, tpgid] = fields.slice(0, 4).map(Number);
		if (![pid, ppid, pgid, tpgid].every(Number.isFinite)) continue;
		processes.set(pid, {
			pid,
			ppid,
			pgid,
			tpgid,
			tty: fields[4],
			state: fields[5],
			command: fields.slice(6).join(' ')
		});
	}
	return processes;
}

export async function listProcesses(): Promise<Map<number, ProcessRecord>> {
	const { stdout } = await execFile(
		'ps',
		['-axo', 'pid=,ppid=,pgid=,tpgid=,tty=,state=,command='],
		{ maxBuffer: PROCESS_TABLE_MAX_BUFFER }
	);
	return parseProcessTable(stdout);
}

function hasControllingTerminal(tty: string | undefined): tty is string {
	return Boolean(tty && tty !== '?' && tty !== '??' && tty !== '-');
}

function isRunningProcess(process: ProcessRecord): boolean {
	return !process.state?.startsWith('Z');
}

class OwnedProcessTracker {
	readonly #ownedProcessIds: Set<number>;
	readonly #ownedProcessGroupIds = new Set<number>();
	readonly #ownedTerminals = new Set<string>();

	constructor(rootProcessIds: Iterable<number>) {
		this.#ownedProcessIds = new Set(
			[...rootProcessIds].filter((pid) => Number.isInteger(pid) && pid > 1)
		);
	}

	activeProcessGroupIds(processes: Map<number, ProcessRecord>): number[] {
		let discovered = true;
		while (discovered) {
			discovered = false;
			for (const process of processes.values()) {
				const owned = this.#ownedProcessIds.has(process.pid);
				const childOfOwnedProcess = this.#ownedProcessIds.has(process.ppid);
				const attachedToOwnedTerminal = hasControllingTerminal(process.tty)
					&& this.#ownedTerminals.has(process.tty);
				const memberOfOwnedGroup = this.#ownedProcessGroupIds.has(process.pgid);
				if (!owned && !childOfOwnedProcess && !attachedToOwnedTerminal && !memberOfOwnedGroup) continue;

				if (!owned) {
					this.#ownedProcessIds.add(process.pid);
					discovered = true;
				}
				if (hasControllingTerminal(process.tty) && !this.#ownedTerminals.has(process.tty)) {
					this.#ownedTerminals.add(process.tty);
					discovered = true;
				}
				if (process.pgid > 1 && !this.#ownedProcessGroupIds.has(process.pgid)) {
					this.#ownedProcessGroupIds.add(process.pgid);
					discovered = true;
				}
			}
		}

		const currentProcessGroupId = processes.get(process.pid)?.pgid;
		return [...this.#ownedProcessGroupIds]
			.filter((processGroupId) => processGroupId !== currentProcessGroupId)
			.filter((processGroupId) => [...processes.values()].some(
				(candidate) => candidate.pgid === processGroupId && isRunningProcess(candidate)
			))
			.sort((left, right) => left - right);
	}
}

const defaultDependencies: ProcessTerminationDependencies = {
	readProcesses: listProcesses,
	signalProcessGroup: (processGroupId, signal) => {
		process.kill(-processGroupId, signal);
	},
	wait: async (durationMs) => {
		await waitForTimeout(durationMs);
	}
};

function signalProcessGroups(
	processGroupIds: number[],
	signal: NodeJS.Signals,
	alreadySignaled: Set<number>,
	dependencies: ProcessTerminationDependencies
): void {
	for (const processGroupId of processGroupIds) {
		if (alreadySignaled.has(processGroupId)) continue;
		alreadySignaled.add(processGroupId);
		try {
			dependencies.signalProcessGroup(processGroupId, signal);
		} catch {
			// A later process-table snapshot decides whether cleanup actually succeeded.
		}
	}
}

async function signalUntilExit(
	tracker: OwnedProcessTracker,
	signal: NodeJS.Signals,
	pollAttempts: number,
	dependencies: ProcessTerminationDependencies,
	signaled = new Set<number>()
): Promise<number[]> {
	let activeProcessGroupIds: number[] = [];
	for (let attempt = 0; attempt <= pollAttempts; attempt += 1) {
		activeProcessGroupIds = tracker.activeProcessGroupIds(await dependencies.readProcesses());
		if (activeProcessGroupIds.length === 0) return [];
		signalProcessGroups(activeProcessGroupIds, signal, signaled, dependencies);
		if (attempt < pollAttempts) await dependencies.wait(PROCESS_EXIT_POLL_INTERVAL_MS);
	}
	return activeProcessGroupIds;
}

function throwTerminationErrors(errors: unknown[]): void {
	if (errors.length === 1) throw errors[0];
	if (errors.length > 1) {
		throw new AggregateError(errors, 'Workspace processes and the tmux target could not be stopped.');
	}
}

export async function terminateProcessTrees(
	rootProcessIds: Iterable<number>,
	releaseTerminal: () => Promise<void>,
	dependencies: ProcessTerminationDependencies = defaultDependencies
): Promise<void> {
	const roots = [...rootProcessIds].filter((pid) => Number.isInteger(pid) && pid > 1);
	if (roots.length === 0) {
		await releaseTerminal();
		return;
	}

	const tracker = new OwnedProcessTracker(roots);
	const terminationErrors: unknown[] = [];
	const termSignaled = new Set<number>();
	let initialProcessGroupIds: number[] = [];
	let canInspectProcesses = true;
	try {
		initialProcessGroupIds = tracker.activeProcessGroupIds(await dependencies.readProcesses());
		signalProcessGroups(initialProcessGroupIds, 'SIGTERM', termSignaled, dependencies);
	} catch (error) {
		canInspectProcesses = false;
		terminationErrors.push(error);
	}

	try {
		await releaseTerminal();
	} catch (error) {
		terminationErrors.push(error);
	}

	if (canInspectProcesses && initialProcessGroupIds.length > 0) {
		try {
			const remainingAfterTerm = await signalUntilExit(
				tracker,
				'SIGTERM',
				GRACEFUL_EXIT_POLL_ATTEMPTS,
				dependencies,
				termSignaled
			);
			if (remainingAfterTerm.length > 0) {
				const remainingAfterKill = await signalUntilExit(
					tracker,
					'SIGKILL',
					FORCED_EXIT_POLL_ATTEMPTS,
					dependencies
				);
				if (remainingAfterKill.length > 0) {
					terminationErrors.push(new Error(
						`Workspace process groups did not stop: ${remainingAfterKill.join(', ')}`
					));
				}
			}
		} catch (error) {
			terminationErrors.push(error);
		}
	}

	throwTerminationErrors(terminationErrors);
}
