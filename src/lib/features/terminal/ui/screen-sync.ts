const TERMINAL_REVEAL_DEADLINE_MS = 1_500;
export const TERMINAL_OUTPUT_BATCH_CHARACTER_LIMIT = 32 * 1024;
export const TERMINAL_OUTPUT_BACKLOG_CHARACTER_LIMIT = 512 * 1024;

function terminalBatchEnd(data: string): number {
  let end = Math.min(TERMINAL_OUTPUT_BATCH_CHARACTER_LIMIT, data.length);
  if (end >= data.length || end === 0) return end;
  const preceding = data.charCodeAt(end - 1);
  const following = data.charCodeAt(end);
  if (preceding >= 0xd800 && preceding <= 0xdbff && following >= 0xdc00 && following <= 0xdfff) end -= 1;
  return end;
}

export interface TerminalSnapshotContext {
  isCurrent: () => boolean;
  acknowledge: () => boolean;
  onRestored?: () => void;
}

export interface TerminalScreenAdapter {
  reset: () => void;
  write: (data: string, complete: () => void) => void;
  refresh: () => void;
  onReadyChange: (ready: boolean) => void;
  onWriteComplete: () => void;
  onScreenReplaced?: () => void;
  onOverflow?: () => void;
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
  #outputFrame: number | undefined;
  #outputOverflowed = false;
  #outputWriteInFlight = false;
  #physicalWriteInFlight = false;
  #pendingOutput = '';
  #pendingSnapshot = '';
  #pendingSnapshotStart: { version: number; context: TerminalSnapshotContext } | undefined;
  #renderingPaused = false;
  #requestFrame: (callback: () => void) => number;
  #revealDeadline: Timer | undefined;
  #revealFrame: number | undefined;
  #screenReplacement: string | undefined;
  #screenReady = false;
  #setTimeout: (callback: () => void, delay: number) => Timer;
  #snapshotFrame: number | undefined;
  #snapshotAcknowledgementVersion = 0;
  #snapshotVersion = 0;
  #snapshotWriteInFlight = false;
  #screenReplacementReset = false;
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
    this.#snapshotAcknowledgementVersion += 1;
    this.#cancelPendingFrames();
    this.#cancelRevealDeadline();
    this.#screenReady = false;
    this.#terminalReady = false;
    this.#initialScreenSettled = false;
    this.#outputOverflowed = false;
    this.#outputWriteInFlight = false;
    this.#pendingOutput = '';
    this.#screenReplacement = undefined;
    this.#screenReplacementReset = false;
    this.#pendingSnapshot = snapshot;
    this.#snapshotWriteInFlight = false;
    this.#adapter.onReadyChange(false);
    this.#pendingSnapshotStart = { version, context };
    this.#startPendingSnapshot();
  }

  pushOutput(output: string): boolean {
    if (this.#disposed || this.#outputOverflowed) return false;
    if (!output) return true;
    if (this.#pendingOutput.length + output.length > TERMINAL_OUTPUT_BACKLOG_CHARACTER_LIMIT) {
      this.#outputOverflowed = true;
      this.#pendingOutput = '';
      if (this.#outputFrame !== undefined) this.#cancelFrame(this.#outputFrame);
      this.#outputFrame = undefined;
      this.#adapter.onOverflow?.();
      return false;
    }
    this.#pendingOutput += output;
    this.#scheduleOutputWrite();
    return true;
  }

  setRenderingPaused(paused: boolean): void {
    if (this.#disposed || this.#renderingPaused === paused) return;
    this.#renderingPaused = paused;
    if (paused) return;
    if (this.#screenReplacement !== undefined) this.#startScreenReplacement();
    else this.#scheduleOutputWrite();
  }

  replaceScreen(screen: string, reset = false): void {
    if (this.#disposed || (!this.#terminalReady && !this.#snapshotWriteInFlight && this.#pendingSnapshot.length === 0))
      return;
    this.#screenReplacement = screen;
    this.#screenReplacementReset = reset;
    this.#pendingOutput = '';
    this.#outputOverflowed = false;
    if (this.#outputFrame !== undefined) this.#cancelFrame(this.#outputFrame);
    this.#outputFrame = undefined;
    this.#startScreenReplacement();
  }

  markScreenReady(): void {
    if (this.#disposed) return;
    this.#initialScreenSettled = true;
    this.#revealSettledTerminal();
  }

  disconnect(): void {
    if (this.#disposed) return;
    this.#snapshotVersion += 1;
    this.#snapshotAcknowledgementVersion += 1;
    this.#terminalReady = false;
    this.#initialScreenSettled = false;
    this.#outputOverflowed = false;
    this.#outputWriteInFlight = false;
    this.#pendingOutput = '';
    this.#screenReplacement = undefined;
    this.#screenReplacementReset = false;
    this.#pendingSnapshot = '';
    this.#pendingSnapshotStart = undefined;
    this.#snapshotWriteInFlight = false;
    this.#cancelPendingFrames();
    this.#cancelRevealDeadline();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.disconnect();
    this.#disposed = true;
  }

  #scheduleOutputWrite(): void {
    if (
      this.#disposed ||
      this.#outputOverflowed ||
      this.#renderingPaused ||
      !this.#terminalReady ||
      this.#physicalWriteInFlight ||
      this.#outputWriteInFlight ||
      this.#outputFrame !== undefined ||
      !this.#pendingOutput
    )
      return;
    this.#outputFrame = this.#requestFrame(() => {
      this.#outputFrame = undefined;
      this.#writeOutputBatch();
    });
  }

  #writeSnapshotBatch(version: number, context: TerminalSnapshotContext): void {
    if (!this.#snapshotIsCurrent(version, context) || this.#snapshotWriteInFlight || this.#physicalWriteInFlight)
      return;
    if (!this.#pendingSnapshot) {
      this.#finishSnapshotWrite(version, context);
      return;
    }
    const batchEnd = terminalBatchEnd(this.#pendingSnapshot);
    const batch = this.#pendingSnapshot.slice(0, batchEnd);
    this.#pendingSnapshot = this.#pendingSnapshot.slice(batchEnd);
    this.#snapshotWriteInFlight = true;
    this.#writePhysical(batch, () => {
      if (!this.#snapshotIsCurrent(version, context)) return;
      this.#snapshotWriteInFlight = false;
      if (!this.#pendingSnapshot) {
        this.#finishSnapshotWrite(version, context);
        return;
      }
      this.#snapshotFrame = this.#requestFrame(() => {
        this.#snapshotFrame = undefined;
        this.#writeSnapshotBatch(version, context);
      });
    });
  }

  #finishSnapshotWrite(version: number, context: TerminalSnapshotContext): void {
    if (!this.#snapshotIsCurrent(version, context)) return;
    context.onRestored?.();
    this.#terminalReady = true;
    if (this.#screenReplacement !== undefined) this.#startScreenReplacement();
    else this.#scheduleOutputWrite();
    this.#revealSettledTerminal();
    this.#scheduleAcknowledgement(this.#snapshotAcknowledgementVersion, context);
  }

  #writeOutputBatch(): void {
    if (
      this.#disposed ||
      this.#outputOverflowed ||
      this.#renderingPaused ||
      this.#outputWriteInFlight ||
      this.#physicalWriteInFlight ||
      !this.#pendingOutput
    )
      return;
    const version = this.#snapshotVersion;
    const batchEnd = terminalBatchEnd(this.#pendingOutput);
    const batch = this.#pendingOutput.slice(0, batchEnd);
    this.#pendingOutput = this.#pendingOutput.slice(batchEnd);
    this.#outputWriteInFlight = true;
    this.#writePhysical(batch, () => {
      if (this.#disposed || version !== this.#snapshotVersion) return;
      this.#outputWriteInFlight = false;
      this.#adapter.onWriteComplete();
      if (this.#screenReplacement !== undefined) {
        this.#startScreenReplacement();
        return;
      }
      this.#revealSettledTerminal();
      this.#scheduleOutputWrite();
    });
  }

  #startScreenReplacement(): void {
    if (
      this.#disposed ||
      this.#renderingPaused ||
      this.#outputWriteInFlight ||
      this.#snapshotWriteInFlight ||
      this.#physicalWriteInFlight ||
      this.#screenReplacement === undefined
    )
      return;
    const screen = this.#screenReplacement;
    const reset = this.#screenReplacementReset;
    this.#screenReplacement = undefined;
    this.#screenReplacementReset = false;
    const version = ++this.#snapshotVersion;
    this.#cancelRevealDeadline();
    this.#terminalReady = false;
    this.#screenReady = false;
    this.#adapter.onReadyChange(false);
    if (reset) this.#adapter.reset();
    this.#snapshotWriteInFlight = true;
    this.#writePhysical(screen, () => {
      if (this.#disposed || version !== this.#snapshotVersion) return;
      this.#snapshotWriteInFlight = false;
      this.#terminalReady = true;
      this.#screenReady = true;
      this.#adapter.onScreenReplaced?.();
      this.#adapter.refresh();
      this.#adapter.onReadyChange(true);
      if (this.#screenReplacement !== undefined) this.#startScreenReplacement();
      else this.#scheduleOutputWrite();
    });
  }

  #startPendingSnapshot(): void {
    if (this.#disposed || this.#physicalWriteInFlight || !this.#pendingSnapshotStart) return;
    const pending = this.#pendingSnapshotStart;
    this.#pendingSnapshotStart = undefined;
    if (!this.#snapshotIsCurrent(pending.version, pending.context)) return;
    this.#adapter.reset();
    this.#writeSnapshotBatch(pending.version, pending.context);
  }

  #writePhysical(data: string, complete: () => void): void {
    if (this.#physicalWriteInFlight) throw new Error('Terminal writes must be serialized.');
    this.#physicalWriteInFlight = true;
    this.#adapter.write(data, () => {
      this.#physicalWriteInFlight = false;
      if (this.#disposed) return;
      if (this.#pendingSnapshotStart) {
        this.#startPendingSnapshot();
        return;
      }
      complete();
    });
  }

  #scheduleAcknowledgement(acknowledgementVersion: number, context: TerminalSnapshotContext): void {
    const acknowledgementIsCurrent = () =>
      !this.#disposed && acknowledgementVersion === this.#snapshotAcknowledgementVersion && context.isCurrent();
    this.#acknowledgementFrame = this.#requestFrame(() => {
      if (!acknowledgementIsCurrent()) return;
      this.#adapter.refresh();
      this.#acknowledgementFrame = this.#requestFrame(() => {
        this.#acknowledgementFrame = undefined;
        if (!acknowledgementIsCurrent()) return;
        this.#adapter.refresh();
        if (context.acknowledge()) this.#startRevealDeadline();
      });
    });
  }

  #revealSettledTerminal(): void {
    if (this.#terminalReady && this.#initialScreenSettled && !this.#outputWriteInFlight && !this.#pendingOutput)
      this.#revealTerminal();
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
    return !this.#disposed && !this.#outputOverflowed && version === this.#snapshotVersion && context.isCurrent();
  }

  #cancelRevealDeadline(): void {
    if (this.#revealDeadline === undefined) return;
    this.#clearTimeout(this.#revealDeadline);
    this.#revealDeadline = undefined;
  }

  #cancelPendingFrames(): void {
    if (this.#acknowledgementFrame !== undefined) this.#cancelFrame(this.#acknowledgementFrame);
    if (this.#revealFrame !== undefined) this.#cancelFrame(this.#revealFrame);
    if (this.#outputFrame !== undefined) this.#cancelFrame(this.#outputFrame);
    if (this.#snapshotFrame !== undefined) this.#cancelFrame(this.#snapshotFrame);
    this.#acknowledgementFrame = undefined;
    this.#revealFrame = undefined;
    this.#outputFrame = undefined;
    this.#snapshotFrame = undefined;
  }
}
