const TERMINAL_REVEAL_DEADLINE_MS = 1_500;

/** @typedef {{ isCurrent: () => boolean; acknowledge: () => boolean }} TerminalSnapshotContext */
/** @typedef {{ reset: () => void; write: (data: string, complete: () => void) => void; refresh: () => void; onReadyChange: (ready: boolean) => void; onWriteComplete: () => void }} TerminalScreenAdapter */
/** @typedef {{ setTimeout?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>; clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void; requestFrame?: (callback: () => void) => number; cancelFrame?: (frame: number) => void }} TerminalScreenDependencies */

export class TerminalScreenSync {
	/** @type {number | undefined} */
	#acknowledgementFrame;
	#adapter;
	#cancelFrame;
	#clearTimeout;
	#disposed = false;
	#initialScreenSettled = false;
	/** @type {string[]} */
	#pendingOutput = [];
	#pendingWrites = 0;
	#requestFrame;
	/** @type {ReturnType<typeof setTimeout> | undefined} */
	#revealDeadline;
	/** @type {number | undefined} */
	#revealFrame;
	#screenReady = false;
	#setTimeout;
	#snapshotVersion = 0;
	#terminalReady = false;

	/** @param {TerminalScreenAdapter} adapter @param {TerminalScreenDependencies} [dependencies] */
	constructor(adapter, dependencies = {}) {
		this.#adapter = adapter;
		this.#setTimeout = dependencies.setTimeout ?? ((callback, delay) => setTimeout(callback, delay));
		this.#clearTimeout = dependencies.clearTimeout ?? ((timer) => clearTimeout(timer));
		this.#requestFrame = dependencies.requestFrame ?? ((callback) => requestAnimationFrame(callback));
		this.#cancelFrame = dependencies.cancelFrame ?? ((frame) => cancelAnimationFrame(frame));
	}

	/** @param {string} snapshot @param {TerminalSnapshotContext} context */
	beginSnapshot(snapshot, context) {
		if (this.#disposed) return;
		const version = ++this.#snapshotVersion;
		this.#cancelPendingFrames();
		this.#cancelRevealDeadline();
		this.#screenReady = false;
		this.#terminalReady = false;
		this.#initialScreenSettled = false;
		this.#pendingWrites = 0;
		this.#pendingOutput = [];
		this.#adapter.onReadyChange(false);
		this.#adapter.reset();
		this.#adapter.write(snapshot, () => {
			if (!this.#snapshotIsCurrent(version, context)) return;
			this.#terminalReady = true;
			const pending = this.#pendingOutput;
			this.#pendingOutput = [];
			for (const output of pending) this.#writeOutput(output);
			this.#revealSettledTerminal();
			this.#scheduleAcknowledgement(version, context);
		});
	}

	/** @param {string} output */
	pushOutput(output) {
		if (this.#disposed) return;
		if (!this.#terminalReady) {
			this.#pendingOutput.push(output);
			return;
		}
		this.#writeOutput(output);
	}

	markScreenReady() {
		if (this.#disposed) return;
		this.#initialScreenSettled = true;
		this.#revealSettledTerminal();
	}

	disconnect() {
		if (this.#disposed) return;
		this.#snapshotVersion += 1;
		this.#terminalReady = false;
		this.#initialScreenSettled = false;
		this.#pendingWrites = 0;
		this.#pendingOutput = [];
		this.#cancelPendingFrames();
		this.#cancelRevealDeadline();
	}

	dispose() {
		if (this.#disposed) return;
		this.disconnect();
		this.#disposed = true;
	}

	/** @param {string} output */
	#writeOutput(output) {
		const version = this.#snapshotVersion;
		if (this.#screenReady) {
			this.#adapter.write(output, () => {
				if (!this.#disposed && version === this.#snapshotVersion) this.#adapter.onWriteComplete();
			});
			return;
		}
		this.#pendingWrites += 1;
		this.#adapter.write(output, () => {
			if (this.#disposed || version !== this.#snapshotVersion) return;
			this.#pendingWrites = Math.max(0, this.#pendingWrites - 1);
			this.#adapter.onWriteComplete();
			this.#revealSettledTerminal();
		});
	}

	/** @param {number} version @param {TerminalSnapshotContext} context */
	#scheduleAcknowledgement(version, context) {
		this.#acknowledgementFrame = this.#requestFrame(() => {
			if (!this.#snapshotIsCurrent(version, context)) return;
			this.#adapter.refresh();
			this.#acknowledgementFrame = this.#requestFrame(() => {
				this.#acknowledgementFrame = undefined;
				if (!this.#snapshotIsCurrent(version, context)) return;
				this.#adapter.refresh();
				if (context.acknowledge()) this.#startRevealDeadline();
			});
		});
	}

	#revealSettledTerminal() {
		if (this.#terminalReady && this.#initialScreenSettled && this.#pendingWrites === 0) this.#revealTerminal();
	}

	#startRevealDeadline() {
		this.#cancelRevealDeadline();
		if (this.#screenReady || this.#disposed) return;
		this.#revealDeadline = this.#setTimeout(() => {
			this.#revealDeadline = undefined;
			this.#revealTerminal();
		}, TERMINAL_REVEAL_DEADLINE_MS);
	}

	#revealTerminal() {
		this.#cancelRevealDeadline();
		if (this.#disposed || this.#screenReady) return;
		this.#adapter.refresh();
		if (this.#revealFrame !== undefined) this.#cancelFrame(this.#revealFrame);
		this.#revealFrame = this.#requestFrame(() => {
			this.#revealFrame = this.#requestFrame(() => {
				this.#revealFrame = undefined;
				if (this.#disposed || this.#screenReady) return;
				this.#screenReady = true;
				this.#adapter.onReadyChange(true);
			});
		});
	}

	/** @param {number} version @param {TerminalSnapshotContext} context */
	#snapshotIsCurrent(version, context) {
		return !this.#disposed && version === this.#snapshotVersion && context.isCurrent();
	}

	#cancelRevealDeadline() {
		if (this.#revealDeadline === undefined) return;
		this.#clearTimeout(this.#revealDeadline);
		this.#revealDeadline = undefined;
	}

	#cancelPendingFrames() {
		if (this.#acknowledgementFrame !== undefined) this.#cancelFrame(this.#acknowledgementFrame);
		if (this.#revealFrame !== undefined) this.#cancelFrame(this.#revealFrame);
		this.#acknowledgementFrame = undefined;
		this.#revealFrame = undefined;
	}
}
