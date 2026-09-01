export interface SequencedTerminalOutput {
  screenSync?: boolean;
  sequence?: number;
  throughSequence?: number;
}

/** Tracks the exact output fence represented by the browser terminal. */
export class TerminalOutputSequence {
  #connectionId = 0;
  #lastSequence = 0;

  reset(): void {
    this.#connectionId = 0;
    this.#lastSequence = 0;
  }

  establish(connectionId: number, throughSequence?: number): void {
    if (throughSequence === undefined) {
      if (this.#connectionId === connectionId) this.reset();
      return;
    }
    this.#connectionId = connectionId;
    this.#lastSequence = throughSequence;
  }

  accept(connectionId: number, output: SequencedTerminalOutput): boolean {
    if (this.#connectionId !== connectionId) {
      return output.sequence === undefined && output.throughSequence === undefined;
    }
    if (output.screenSync) {
      if (output.throughSequence === undefined || output.throughSequence < this.#lastSequence) return false;
      this.#lastSequence = output.throughSequence;
      return true;
    }
    if (output.sequence !== this.#lastSequence + 1) return false;
    this.#lastSequence = output.sequence;
    return true;
  }
}
