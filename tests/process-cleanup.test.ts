import assert from 'node:assert/strict';
import test from 'node:test';
import {
	parseProcessTable,
	terminateProcessTrees,
	type ProcessRecord,
	type ProcessTerminationDependencies
} from '../src/lib/server/process-cleanup.ts';

test('parses process ownership fields without splitting command arguments', () => {
	assert.deepEqual(
		parseProcessTable(' 42  10  42  43 ttys007 S+ node /tmp/server.js --port 4000\n').get(42),
		{
			pid: 42,
			ppid: 10,
			pgid: 42,
			tpgid: 43,
			tty: 'ttys007',
			state: 'S+',
			command: 'node /tmp/server.js --port 4000'
		}
	);
});

function processRecord(
	pid: number,
	ppid: number,
	pgid: number,
	tty: string,
	command: string
): ProcessRecord {
	return { pid, ppid, pgid, tpgid: pgid, tty, state: 'S', command };
}

function processTable(records: ProcessRecord[]): Map<number, ProcessRecord> {
	return new Map(records.map((record) => [record.pid, record]));
}

test('gracefully terminates every process group owned by a pane', async () => {
	const initial = processTable([
		processRecord(100, 10, 100, 'ttys001', 'zsh'),
		processRecord(101, 100, 101, 'ttys001', 'codex'),
		processRecord(102, 101, 102, 'ttys001', 'helper'),
		processRecord(103, 1, 103, 'ttys001', 'reparented-helper'),
		processRecord(200, 1, 200, 'ttys002', 'unrelated-server')
	]);
	const signals: Array<[number, NodeJS.Signals]> = [];
	let terminated = false;
	const dependencies: ProcessTerminationDependencies = {
		readProcesses: async () => terminated ? processTable([initial.get(200)!]) : initial,
		signalProcessGroup: (processGroupId, signal) => {
			signals.push([processGroupId, signal]);
			if (signal === 'SIGTERM') terminated = true;
		},
		wait: async () => undefined
	};

	await terminateProcessTrees([100], async () => undefined, dependencies);

	assert.deepEqual(signals, [
		[100, 'SIGTERM'],
		[101, 'SIGTERM'],
		[102, 'SIGTERM'],
		[103, 'SIGTERM']
	]);
});

test('force kills process groups that ignore graceful termination', async () => {
	const initial = processTable([
		processRecord(300, 10, 300, 'ttys003', 'pnpm'),
		processRecord(301, 300, 300, 'ttys003', 'concurrently'),
		processRecord(302, 301, 302, 'ttys003', 'nodemon')
	]);
	const signals: Array<[number, NodeJS.Signals]> = [];
	const events: string[] = [];
	let forceKilled = false;
	const dependencies: ProcessTerminationDependencies = {
		readProcesses: async () => forceKilled ? new Map() : initial,
		signalProcessGroup: (processGroupId, signal) => {
			signals.push([processGroupId, signal]);
			events.push(`${signal}:${processGroupId}`);
			if (signal === 'SIGKILL') forceKilled = true;
		},
		wait: async () => undefined
	};

	await terminateProcessTrees([300], async () => {
		events.push('terminal-released');
	}, dependencies);

	assert.deepEqual(signals.filter(([, signal]) => signal === 'SIGTERM'), [
		[300, 'SIGTERM'],
		[302, 'SIGTERM']
	]);
	assert.deepEqual(signals.filter(([, signal]) => signal === 'SIGKILL'), [
		[300, 'SIGKILL'],
		[302, 'SIGKILL']
	]);
	assert.ok(events.indexOf('terminal-released') > events.indexOf('SIGTERM:302'));
	assert.ok(events.indexOf('terminal-released') < events.indexOf('SIGKILL:300'));
});

test('reports process groups that remain after forced termination', async () => {
	const initial = processTable([
		processRecord(400, 10, 400, 'ttys004', 'stuck-process')
	]);
	const dependencies: ProcessTerminationDependencies = {
		readProcesses: async () => initial,
		signalProcessGroup: () => undefined,
		wait: async () => undefined
	};

	await assert.rejects(
		terminateProcessTrees([400], async () => undefined, dependencies),
		/Workspace process groups did not stop: 400/
	);
});

test('continues process cleanup when releasing the terminal fails', async () => {
	const initial = processTable([
		processRecord(500, 10, 500, 'ttys005', 'pnpm')
	]);
	let forceKilled = false;
	const dependencies: ProcessTerminationDependencies = {
		readProcesses: async () => forceKilled ? new Map() : initial,
		signalProcessGroup: (_processGroupId, signal) => {
			if (signal === 'SIGKILL') forceKilled = true;
		},
		wait: async () => undefined
	};

	await assert.rejects(
		terminateProcessTrees(
			[500],
			async () => { throw new Error('tmux failed'); },
			dependencies
		),
		/tmux failed/
	);
	assert.equal(forceKilled, true);
});
