export interface SequencedTerminalDelivery<T> {
  bytes: number;
  sequence: number;
  value: T;
}

export interface TerminalDeliveryBatch<TOutput> {
  outputs: Array<SequencedTerminalDelivery<TOutput>>;
}

export interface TerminalDeliveryEnqueueResult<TOutput> extends TerminalDeliveryBatch<TOutput> {
  overflowed: boolean;
}

/**
 * Per-subscriber delivery fence between the initial authoritative tmux capture
 * and the wire. Output observed before the browser acknowledges that capture is
 * held and then released in sequence order. Once acknowledged, output is sent
 * directly without inventing a second screen state.
 */
export class TerminalDeliveryBuffer<TOutput> {
  #acknowledged = false;
  #authoritativeThroughSequence = 0;
  #latestObservedSequence = 0;
  #maximumPendingBytes: number;
  #pendingBytes = 0;
  #pendingOutputs: Array<SequencedTerminalDelivery<TOutput>> = [];
  #snapshotSent = false;

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
  }

  publishSnapshot(throughSequence: number): void {
    this.#snapshotSent = true;
    this.#advanceAuthoritativeFence(throughSequence);
  }

  acknowledge(): TerminalDeliveryBatch<TOutput> {
    if (!this.#snapshotSent || this.#acknowledged) return { outputs: [] };
    this.#acknowledged = true;
    return this.#drain();
  }

  enqueueOutput(output: SequencedTerminalDelivery<TOutput>): TerminalDeliveryEnqueueResult<TOutput> {
    if (output.sequence <= this.#authoritativeThroughSequence || output.sequence <= this.#latestObservedSequence) {
      return { outputs: [], overflowed: false };
    }
    this.#latestObservedSequence = output.sequence;
    if (this.#snapshotSent && this.#acknowledged) return { outputs: [output], overflowed: false };
    if (this.#pendingBytes + output.bytes > this.#maximumPendingBytes) return { outputs: [], overflowed: true };
    this.#pendingOutputs.push(output);
    this.#pendingBytes += output.bytes;
    return { outputs: [], overflowed: false };
  }

  clear(): void {
    this.#acknowledged = false;
    this.#pendingBytes = 0;
    this.#pendingOutputs = [];
    this.#snapshotSent = false;
  }

  #advanceAuthoritativeFence(throughSequence: number): void {
    this.#authoritativeThroughSequence = Math.max(this.#authoritativeThroughSequence, throughSequence);
    this.#latestObservedSequence = Math.max(this.#latestObservedSequence, throughSequence);
    if (this.#pendingOutputs.length === 0) return;
    this.#pendingOutputs = this.#pendingOutputs.filter(
      (output) => output.sequence > this.#authoritativeThroughSequence,
    );
    this.#pendingBytes = this.#pendingOutputs.reduce((total, output) => total + output.bytes, 0);
  }

  #drain(): TerminalDeliveryBatch<TOutput> {
    if (!this.#snapshotSent || !this.#acknowledged) return { outputs: [] };
    const batch = { outputs: this.#pendingOutputs };
    this.#pendingOutputs = [];
    this.#pendingBytes = 0;
    return batch;
  }
}
