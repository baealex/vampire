const TERMINAL_REVEAL_DEADLINE_MS = 1_500;

export interface TerminalSnapshotContext {
	isCurrent: () => boolean;
	acknowledge: () => boolean;
}

export interface TerminalScreenAdapter {
	reset: () => void;
	write: (data: string, complete: () => void) => void;
	refresh: () => void;
	onReadyChange: (ready: boolean) => void;
	onWriteComplete: () => void;
}

type Timer = unknown;

export interface TerminalScreenDependencies {
	setTimeout?: (callback: () => void, delay: number) => Timer;
	clearTimeout?: (timer: Timer) => void;
	requestFrame?: (callback: () => void) => number;
	cancelFrame?: (frame: number) => void;
}

export class TerminalScreenSync {
	#acknowledgementFrame: number | undefined;
	#adapter: TerminalScreenAdapter;
	#cancelFrame: (frame: number) => void;
	#clearTimeout: (timer: Timer) => void;
	#disposed = false;
	#initialScreenSettled = false;
	#pendingOutput: string[] = [];
	#pendingWrites = 0;
	#requestFrame: (callback: () => void) => number;
	#revealDeadline: Timer | undefined;
	#revealFrame: number | undefined;
	#screenReady = false;
	#setTimeout: (callback: () => void, delay: number) => Timer;
	#snapshotVersion = 0;
	#terminalReady = false;

	constructor(adapter: TerminalScreenAdapter, dependencies: TerminalScreenDependencies = {}) {
		this.#adapter = adapter;
		this.#setTimeout = dependencies.setTimeout ?? ((callback, delay) => setTimeout(callback, delay));
		this.#clearTimeout = dependencies.clearTimeout ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
		this.#requestFrame = dependencies.requestFrame ?? ((callback) => requestAnimationFrame(callback));
		this.#cancelFrame = dependencies.cancelFrame ?? ((frame) => cancelAnimationFrame(frame));
	}

	beginSnapshot(snapshot: string, context: TerminalSnapshotContext): void {
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

	pushOutput(output: string): void {
		if (this.#disposed) return;
		if (!this.#terminalReady) {
			this.#pendingOutput.push(output);
			return;
		}
		this.#writeOutput(output);
	}

	markScreenReady(): void {
		if (this.#disposed) return;
		this.#initialScreenSettled = true;
		this.#revealSettledTerminal();
	}

	disconnect(): void {
		if (this.#disposed) return;
		this.#snapshotVersion += 1;
		this.#terminalReady = false;
		this.#initialScreenSettled = false;
		this.#pendingWrites = 0;
		this.#pendingOutput = [];
		this.#cancelPendingFrames();
		this.#cancelRevealDeadline();
	}

	dispose(): void {
		if (this.#disposed) return;
		this.disconnect();
		this.#disposed = true;
	}

	#writeOutput(output: string): void {
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

	#scheduleAcknowledgement(version: number, context: TerminalSnapshotContext): void {
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

	#revealSettledTerminal(): void {
		if (this.#terminalReady && this.#initialScreenSettled && this.#pendingWrites === 0) this.#revealTerminal();
	}

	#startRevealDeadline(): void {
		this.#cancelRevealDeadline();
		if (this.#screenReady || this.#disposed) return;
		this.#revealDeadline = this.#setTimeout(() => {
			this.#revealDeadline = undefined;
			this.#revealTerminal();
		}, TERMINAL_REVEAL_DEADLINE_MS);
	}

	#revealTerminal(): void {
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

	#snapshotIsCurrent(version: number, context: TerminalSnapshotContext): boolean {
		return !this.#disposed && version === this.#snapshotVersion && context.isCurrent();
	}

	#cancelRevealDeadline(): void {
		if (this.#revealDeadline === undefined) return;
		this.#clearTimeout(this.#revealDeadline);
		this.#revealDeadline = undefined;
	}

	#cancelPendingFrames(): void {
		if (this.#acknowledgementFrame !== undefined) this.#cancelFrame(this.#acknowledgementFrame);
		if (this.#revealFrame !== undefined) this.#cancelFrame(this.#revealFrame);
		this.#acknowledgementFrame = undefined;
		this.#revealFrame = undefined;
	}
}
