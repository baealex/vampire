import type { SessionTerminal } from './types.ts';

type TerminalOverrides = {
	started: Map<string, SessionTerminal>;
	stopped: Set<string>;
};

/**
 * Keeps successful local background-process mutations visible until the
 * session stream reports the same state. This prevents an older stream poll
 * from briefly undoing an HTTP mutation that completed after that poll began.
 */
export class BackgroundTerminalReconciler {
	readonly #bySession = new Map<string, TerminalOverrides>();

	applyStarted(
		sessionId: string,
		current: SessionTerminal[],
		process: SessionTerminal
	): SessionTerminal[] {
		const overrides = this.#overridesFor(sessionId);
		overrides.stopped.delete(process.id);
		overrides.started.set(process.id, process);
		if (current.some((terminal) => terminal.id === process.id)) {
			overrides.started.delete(process.id);
		}
		this.#deleteIfEmpty(sessionId, overrides);

		return [
			...current.filter((terminal) => terminal.id !== process.id),
			process
		].sort((left, right) => left.index - right.index);
	}

	applyStopped(sessionId: string, current: SessionTerminal[], processId: string): SessionTerminal[] {
		const overrides = this.#overridesFor(sessionId);
		overrides.started.delete(processId);
		overrides.stopped.add(processId);
		if (!current.some((terminal) => terminal.id === processId)) {
			overrides.stopped.delete(processId);
		}
		this.#deleteIfEmpty(sessionId, overrides);

		return current.filter((terminal) => terminal.id !== processId);
	}

	reconcile(sessionId: string, incoming: SessionTerminal[]): SessionTerminal[] {
		const overrides = this.#bySession.get(sessionId);
		if (!overrides) return incoming;

		const incomingIds = new Set(incoming.map((terminal) => terminal.id));
		for (const processId of overrides.started.keys()) {
			if (incomingIds.has(processId)) overrides.started.delete(processId);
		}
		for (const processId of overrides.stopped) {
			if (!incomingIds.has(processId)) overrides.stopped.delete(processId);
		}

		const terminals = incoming.filter((terminal) => !overrides.stopped.has(terminal.id));
		for (const process of overrides.started.values()) {
			if (!incomingIds.has(process.id)) terminals.push(process);
		}

		this.#deleteIfEmpty(sessionId, overrides);
		return terminals.sort((left, right) => left.index - right.index);
	}

	clearSession(sessionId: string): void {
		this.#bySession.delete(sessionId);
	}

	clear(): void {
		this.#bySession.clear();
	}

	#overridesFor(sessionId: string): TerminalOverrides {
		let overrides = this.#bySession.get(sessionId);
		if (!overrides) {
			overrides = { started: new Map(), stopped: new Set() };
			this.#bySession.set(sessionId, overrides);
		}
		return overrides;
	}

	#deleteIfEmpty(sessionId: string, overrides: TerminalOverrides): void {
		if (overrides.started.size === 0 && overrides.stopped.size === 0) {
			this.#bySession.delete(sessionId);
		}
	}
}
