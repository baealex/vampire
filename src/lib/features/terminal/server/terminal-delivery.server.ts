export interface SequencedTerminalDelivery<T> {
  bytes: number;
  sequence: number;
  value: T;
}

export interface FencedTerminalDelivery<T> {
  throughSequence: number;
  value: T;
}

export interface TerminalDeliveryBatch<TOutput, TSynchronization> {
  outputs: Array<SequencedTerminalDelivery<TOutput>>;
  synchronization?: FencedTerminalDelivery<TSynchronization>;
}

export interface TerminalDeliveryEnqueueResult<TOutput, TSynchronization>
  extends TerminalDeliveryBatch<TOutput, TSynchronization> {
  overflowed: boolean;
}

/**
 * Per-subscriber delivery fence between canonical terminal state and the wire.
 *
 * A snapshot/reset represents every canonical output through its sequence. Any
 * earlier delta is discarded, later deltas stay ordered behind that frame, and
 * nothing drains until the browser has acknowledged its snapshot. This keeps a
 * resize reset from overtaking output already waiting for snapshot ACK.
 */
export class TerminalDeliveryBuffer<TOutput, TSynchronization> {
  #acknowledged = false;
  #authoritativeThroughSequence = 0;
  #holdingSynchronization = false;
  #latestObservedSequence = 0;
  #maximumPendingBytes: number;
  #pendingBytes = 0;
  #pendingOutputs: Array<SequencedTerminalDelivery<TOutput>> = [];
  #pendingSynchronization: FencedTerminalDelivery<TSynchronization> | undefined;
  #snapshotSent = false;
  #synchronizationGeneration = 0;

  constructor(maximumPendingBytes: number) {
    this.#maximumPendingBytes = Math.max(0, maximumPendingBytes);
  }

  get acknowledged(): boolean {
    return this.#acknowledged;
  }

  get snapshotSent(): boolean {
    return this.#snapshotSent;
  }

  beginSnapshot(): void {
    this.#acknowledged = false;
    this.#snapshotSent = false;
    this.#pendingSynchronization = undefined;
    this.#holdingSynchronization = false;
    this.#synchronizationGeneration += 1;
  }

  publishSnapshot(throughSequence: number): void {
    this.#snapshotSent = true;
    this.#advanceAuthoritativeFence(throughSequence);
  }

  acknowledge(): TerminalDeliveryBatch<TOutput, TSynchronization> {
    if (!this.#snapshotSent || this.#acknowledged) return { outputs: [] };
    this.#acknowledged = true;
    return this.#drain();
  }

  enqueueOutput(output: SequencedTerminalDelivery<TOutput>): TerminalDeliveryEnqueueResult<TOutput, TSynchronization> {
    if (output.sequence <= this.#authoritativeThroughSequence || output.sequence <= this.#latestObservedSequence) {
      return { outputs: [], overflowed: false };
    }
    this.#latestObservedSequence = output.sequence;
    if (this.#snapshotSent && this.#acknowledged && !this.#holdingSynchronization) {
      return { outputs: [output], overflowed: false };
    }
    if (this.#pendingBytes + output.bytes > this.#maximumPendingBytes) {
      return { outputs: [], overflowed: true };
    }
    this.#pendingOutputs.push(output);
    this.#pendingBytes += output.bytes;
    return { outputs: [], overflowed: false };
  }

  beginSynchronization(): number {
    this.#holdingSynchronization = true;
    return ++this.#synchronizationGeneration;
  }

  completeSynchronization(
    generation: number,
    synchronization: FencedTerminalDelivery<TSynchronization>
  ): TerminalDeliveryBatch<TOutput, TSynchronization> {
    if (generation !== this.#synchronizationGeneration) return { outputs: [] };
    this.#advanceAuthoritativeFence(synchronization.throughSequence);
    this.#pendingSynchronization = synchronization;
    this.#holdingSynchronization = false;
    return this.#drain();
  }

  abandonSynchronization(generation: number): TerminalDeliveryBatch<TOutput, TSynchronization> {
    if (generation !== this.#synchronizationGeneration) return { outputs: [] };
    // A stale capture cannot prove that its queued deltas are safe for the
    // browser's current geometry. Keep them fenced until the replacement
    // synchronization advances the authoritative sequence.
    this.#pendingSynchronization = undefined;
    return { outputs: [] };
  }

  clear(): void {
    this.#acknowledged = false;
    this.#holdingSynchronization = false;
    this.#pendingBytes = 0;
    this.#pendingOutputs = [];
    this.#pendingSynchronization = undefined;
    this.#snapshotSent = false;
    this.#synchronizationGeneration += 1;
  }

  #advanceAuthoritativeFence(throughSequence: number): void {
    this.#authoritativeThroughSequence = Math.max(this.#authoritativeThroughSequence, throughSequence);
    this.#latestObservedSequence = Math.max(this.#latestObservedSequence, throughSequence);
    if (this.#pendingOutputs.length === 0) return;
    this.#pendingOutputs = this.#pendingOutputs.filter(
      (output) => output.sequence > this.#authoritativeThroughSequence
    );
    this.#pendingBytes = this.#pendingOutputs.reduce((total, output) => total + output.bytes, 0);
  }

  #drain(): TerminalDeliveryBatch<TOutput, TSynchronization> {
    if (!this.#snapshotSent || !this.#acknowledged || this.#holdingSynchronization) return { outputs: [] };
    const batch = {
      outputs: this.#pendingOutputs,
      ...(this.#pendingSynchronization ? { synchronization: this.#pendingSynchronization } : {}),
    };
    this.#pendingOutputs = [];
    this.#pendingBytes = 0;
    this.#pendingSynchronization = undefined;
    return batch;
  }
}
