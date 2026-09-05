import { createRequire } from 'node:module';

import type { Terminal as HeadlessTerminal } from '@xterm/headless';
import type { SerializeAddon as TerminalSerializeAddon } from '@xterm/addon-serialize';

const require = createRequire(import.meta.url);
const { Terminal } = require('@xterm/headless') as typeof import('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize') as typeof import('@xterm/addon-serialize');

const DEFAULT_OUTPUT_RING_BYTES = 2 * 1024 * 1024;
const OUTPUT_PARSE_BATCH_BYTES = 32 * 1024;

export interface CanonicalTerminalGeometry {
  columns: number;
  rows: number;
}

export interface CanonicalTerminalOutput {
  sequence: number;
  data: string;
}

export interface CanonicalTerminalSnapshot {
  alternateScreen: boolean;
  availableHistory: number;
  data: string;
  geometry: CanonicalTerminalGeometry;
  throughSequence: number;
}

export interface CanonicalTerminalDeltas {
  available: boolean;
  entries: CanonicalTerminalOutput[];
  throughSequence: number;
}

export interface TerminalCanonicalModelOptions {
  outputRingBytes?: number;
  scrollback?: number;
}

interface RetainedTerminalOutput extends CanonicalTerminalOutput {
  bytes: number;
}

interface TerminalWriteBatch {
  chunks: string[];
  bytes: number;
  result: Promise<CanonicalTerminalOutput[]>;
}

function writeTerminal(terminal: HeadlessTerminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}

/**
 * A server-side xterm parser that is the ordered source of truth for a pane.
 *
 * Every mutation and observation uses the same promise actor. A snapshot can
 * therefore name the exact output sequence it contains, and callers can replay
 * only the later deltas without racing xterm's asynchronous parser.
 */
export class TerminalCanonicalModel {
  #disposed = false;
  #geometry: CanonicalTerminalGeometry;
  #operationQueue: Promise<void> = Promise.resolve();
  #pendingWriteBatch: TerminalWriteBatch | undefined;
  #outputRing: RetainedTerminalOutput[] = [];
  #outputRingBytes = 0;
  #outputRingLimit: number;
  #replayFloorSequence = 0;
  #sequence = 0;
  #serializeAddon!: TerminalSerializeAddon;
  #terminal!: HeadlessTerminal;
  #scrollback: number;

  constructor(geometry: CanonicalTerminalGeometry, options: TerminalCanonicalModelOptions = {}) {
    this.#geometry = { ...geometry };
    this.#outputRingLimit = Math.max(0, options.outputRingBytes ?? DEFAULT_OUTPUT_RING_BYTES);
    this.#scrollback = Math.max(0, options.scrollback ?? 10_000);
    this.#createTerminal();
  }

  get geometry(): CanonicalTerminalGeometry {
    return { ...this.#geometry };
  }

  get sequence(): number {
    return this.#sequence;
  }

  write(data: string): Promise<CanonicalTerminalOutput | undefined> {
    if (this.#disposed || !data) return Promise.resolve(undefined);
    const bytes = Buffer.byteLength(data);
    const pending = this.#pendingWriteBatch;
    if (pending && pending.bytes + bytes <= OUTPUT_PARSE_BATCH_BYTES) {
      const index = pending.chunks.push(data) - 1;
      pending.bytes += bytes;
      return pending.result.then((entries) => entries[index]);
    }
    const chunks = [data];
    const result = this.#enqueue(async () => {
      if (this.#pendingWriteBatch?.chunks === chunks) this.#pendingWriteBatch = undefined;
      if (this.#disposed) return [];
      await writeTerminal(this.#terminal, chunks.join(''));
      return chunks.map((chunk) => {
        const entry = { sequence: ++this.#sequence, data: chunk, bytes: Buffer.byteLength(chunk) };
        this.#retain(entry);
        return { sequence: entry.sequence, data: entry.data };
      });
    });
    this.#pendingWriteBatch = { chunks, bytes, result };
    return result.then((entries) => entries[0]);
  }

  resize(geometry: CanonicalTerminalGeometry): Promise<CanonicalTerminalSnapshot> {
    return this.#enqueue(() => {
      this.#assertAvailable();
      if (geometry.columns !== this.#geometry.columns || geometry.rows !== this.#geometry.rows) {
        this.#terminal.resize(geometry.columns, geometry.rows);
        this.#geometry = { ...geometry };
      }
      return this.#snapshotNow();
    });
  }

  snapshot(scrollback = this.#scrollback): Promise<CanonicalTerminalSnapshot> {
    return this.#enqueue(() => {
      this.#assertAvailable();
      return this.#snapshotNow(scrollback);
    });
  }

  /** Replace the entire model at a known sequence fence. */
  restore(
    data: string,
    geometry: CanonicalTerminalGeometry,
    throughSequence?: number,
    scrollback = this.#scrollback
  ): Promise<CanonicalTerminalSnapshot> {
    return this.#enqueue(async () => {
      this.#assertAvailable();
      this.#terminal.dispose();
      this.#geometry = { ...geometry };
      this.#scrollback = Math.max(0, scrollback);
      this.#createTerminal();
      if (data) await writeTerminal(this.#terminal, data);
      this.#sequence = throughSequence ?? this.#sequence;
      this.#outputRing = [];
      this.#outputRingBytes = 0;
      this.#replayFloorSequence = this.#sequence;
      return this.#snapshotNow();
    });
  }

  deltasAfter(sequence: number): Promise<CanonicalTerminalDeltas> {
    return this.#enqueue(() => {
      this.#assertAvailable();
      const available = sequence >= this.#replayFloorSequence && sequence <= this.#sequence;
      return {
        available,
        entries: available
          ? this.#outputRing
              .filter((entry) => entry.sequence > sequence)
              .map(({ sequence: outputSequence, data }) => ({ sequence: outputSequence, data }))
          : [],
        throughSequence: this.#sequence,
      };
    });
  }

  settled(): Promise<number> {
    return this.#enqueue(() => {
      this.#assertAvailable();
      return this.#sequence;
    });
  }

  dispose(): Promise<void> {
    if (this.#disposed) return this.#operationQueue;
    this.#disposed = true;
    return this.#enqueue(() => {
      this.#terminal.dispose();
      this.#outputRing = [];
      this.#outputRingBytes = 0;
      this.#replayFloorSequence = this.#sequence;
    });
  }

  #createTerminal(): void {
    this.#terminal = new Terminal({
      cols: this.#geometry.columns,
      rows: this.#geometry.rows,
      scrollback: this.#scrollback,
      // Match the browser terminal exactly. tmux capture-pane emits LF record
      // separators, so leaving xterm's default false would continue each row at
      // the previous cursor column and corrupt wide snapshots.
      convertEol: true,
      // The official serialize addon reads xterm's buffer API, which headless
      // xterm currently guards as proposed even though the addon is released
      // alongside the same xterm version.
      allowProposedApi: true,
    });
    this.#serializeAddon = new SerializeAddon();
    // The serialize addon targets the shared xterm API surface. Headless xterm
    // implements that same runtime contract but publishes a separate nominal
    // Terminal declaration, so bridge the declaration-only mismatch here.
    this.#terminal.loadAddon(this.#serializeAddon as unknown as Parameters<HeadlessTerminal['loadAddon']>[0]);
  }

  #assertAvailable(): void {
    if (this.#disposed) throw new Error('Canonical terminal model is unavailable.');
  }

  #enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    // Observations and geometry/restoration changes seal the preceding batch.
    // No later output may be parsed on the other side of that sequence fence.
    this.#pendingWriteBatch = undefined;
    const result = this.#operationQueue.catch(() => undefined).then(operation);
    this.#operationQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  #retain(entry: RetainedTerminalOutput): void {
    this.#outputRing.push(entry);
    this.#outputRingBytes += entry.bytes;
    while (this.#outputRingBytes > this.#outputRingLimit && this.#outputRing.length > 0) {
      const removed = this.#outputRing.shift();
      if (!removed) break;
      this.#outputRingBytes -= removed.bytes;
      this.#replayFloorSequence = removed.sequence;
    }
  }

  #snapshotNow(scrollback = this.#scrollback): CanonicalTerminalSnapshot {
    return {
      alternateScreen: this.#terminal.buffer.active.type === 'alternate',
      availableHistory: this.#terminal.buffer.normal.baseY,
      data: this.#serializeAddon.serialize({ scrollback: Math.max(0, scrollback) }),
      geometry: { ...this.#geometry },
      throughSequence: this.#sequence,
    };
  }
}
