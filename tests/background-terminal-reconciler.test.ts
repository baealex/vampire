import assert from 'node:assert/strict';
import test from 'node:test';
import { BackgroundTerminalReconciler } from '../src/lib/session/background-terminal-reconciler.ts';
import type { SessionTerminal } from '../src/lib/session/types.ts';

function terminal(id: string, index: number): SessionTerminal {
	return {
		id,
		index,
		name: index === 0 ? 'main' : 'background',
		active: index === 0,
		lastOutputAt: null,
		foregroundProcess: null,
		command: index === 0 ? null : 'pnpm test',
		startedAt: index === 0 ? null : 1_000,
		state: 'running',
		exitCode: null
	};
}

function ids(terminals: SessionTerminal[]): string[] {
	return terminals.map((item) => item.id);
}

test('a started terminal survives stale snapshots until the stream acknowledges it', () => {
	const reconciler = new BackgroundTerminalReconciler();
	const main = terminal('@1', 0);
	const started = terminal('@2', 1);

	assert.deepEqual(ids(reconciler.applyStarted('session-1', [main], started)), ['@1', '@2']);
	assert.deepEqual(ids(reconciler.reconcile('session-1', [main])), ['@1', '@2']);
	assert.deepEqual(ids(reconciler.reconcile('session-1', [main, started])), ['@1', '@2']);
	assert.deepEqual(ids(reconciler.reconcile('session-1', [main])), ['@1']);
});

test('a stopped terminal stays removed until the stream acknowledges it', () => {
	const reconciler = new BackgroundTerminalReconciler();
	const main = terminal('@1', 0);
	const stopped = terminal('@2', 1);

	assert.deepEqual(ids(reconciler.applyStopped('session-1', [main, stopped], stopped.id)), ['@1']);
	assert.deepEqual(ids(reconciler.reconcile('session-1', [main, stopped])), ['@1']);
	assert.deepEqual(ids(reconciler.reconcile('session-1', [main])), ['@1']);
	assert.deepEqual(ids(reconciler.reconcile('session-1', [main, stopped])), ['@1', '@2']);
});

test('accepts the current stream when it already reflects the HTTP mutation', () => {
	const main = terminal('@1', 0);
	const process = terminal('@2', 1);
	const started = new BackgroundTerminalReconciler();
	const stopped = new BackgroundTerminalReconciler();

	assert.deepEqual(ids(started.applyStarted('session-1', [main, process], process)), ['@1', '@2']);
	assert.deepEqual(ids(started.reconcile('session-1', [main])), ['@1']);

	assert.deepEqual(ids(stopped.applyStopped('session-1', [main], process.id)), ['@1']);
	assert.deepEqual(ids(stopped.reconcile('session-1', [main, process])), ['@1', '@2']);
});

test('a new local start does not acknowledge an earlier local stop', () => {
	const reconciler = new BackgroundTerminalReconciler();
	const main = terminal('@1', 0);
	const stopped = terminal('@2', 1);
	const started = terminal('@3', 2);

	assert.deepEqual(ids(reconciler.applyStopped('session-1', [main, stopped], stopped.id)), ['@1']);
	assert.deepEqual(ids(reconciler.applyStarted('session-1', [main], started)), ['@1', '@3']);
	assert.deepEqual(ids(reconciler.reconcile('session-1', [main, stopped])), ['@1', '@3']);
	assert.deepEqual(ids(reconciler.reconcile('session-1', [main, started])), ['@1', '@3']);
});
