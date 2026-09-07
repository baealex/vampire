/** Bounds output already handed to TCP, including bytes outside ws.bufferedAmount.
 * A matching WebSocket pong confirms receipt through the preceding ping. While
 * waiting, canonical state continues advancing; a fenced reset replaces skipped
 * deltas before this subscriber can resume ordinary output.
 */
export class TerminalOutputFlow {
  #bytes = 0;
  #ping = 0;
  #waiting: string | undefined;
  #dirty = false;

  readonly maximumBytes: number;

  constructor(maximumBytes = 32 * 1024) {
    this.maximumBytes = maximumBytes;
  }

  get needsSynchronization(): boolean {
    return this.#dirty && this.#waiting === undefined;
  }

  canSend(synchronization: boolean): boolean {
    if (this.#waiting !== undefined || (this.#dirty && !synchronization)) {
      this.#dirty = true;
      return false;
    }
    if (synchronization) this.#dirty = false;
    return true;
  }

  sent(bytes: number): string | undefined {
    this.#bytes += bytes;
    if (this.#bytes < this.maximumBytes || this.#waiting !== undefined) return undefined;
    this.#waiting = `vampire-output-${++this.#ping}`;
    return this.#waiting;
  }

  acknowledge(token: string): boolean {
    if (token !== this.#waiting) return false;
    this.#waiting = undefined;
    this.#bytes = 0;
    return this.#dirty;
  }
}
