import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import {
  TerminalCanonicalModel,
  type CanonicalTerminalGeometry,
  type CanonicalTerminalOutput,
  type CanonicalTerminalSnapshot,
} from './terminal-canonical-model.server.ts';
import { parseTmuxControlOutput } from './tmux-control.server.ts';

const CONTROL_COMMAND_TIMEOUT_MS = 3_000;
const CONTROL_ATTACH_TIMEOUT_MS = 3_000;
const HUB_RECONNECT_LINGER_MS = 5_000;
const MAX_TERMINAL_CONTROL_HUBS = 32;
const MAX_PENDING_CANONICAL_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_PENDING_CANONICAL_OUTPUT_OPERATIONS = 16_384;
const MAX_TMUX_CONTROL_LINE_BYTES = 8 * 1024 * 1024;

interface PendingControlCommand {
  resolve: (output: string) => void;
  reject: (reason: unknown) => void;
  onSuccess?: (output: string) => void;
  timer: NodeJS.Timeout;
}

interface ControlCommandBlock {
  command: PendingControlCommand | undefined;
  output: string[];
}

export interface TerminalControlHubOutput extends CanonicalTerminalOutput {}

export interface TerminalControlHubSubscriber {
  onOutput: (output: TerminalControlHubOutput) => void;
  onUnavailable: (error: Error) => void;
}

export interface TerminalControlHubInitialization {
  availableHistory: number;
  loadedHistory: number;
}

interface TerminalControlHubEntry {
  hub: TerminalControlHub;
  references: number;
  disposalTimer?: ReturnType<typeof setTimeout>;
}

export interface TerminalControlHubLease {
  hub: TerminalControlHub;
  release: () => void;
}

const terminalControlHubs = new Map<string, TerminalControlHubEntry>();

function terminalControlHubKey(tmuxSession: string, paneId: string): string {
  return `${tmuxSession}\u0000${paneId}`;
}

/**
 * One tmux control client and one xterm parser per pane, shared by every browser.
 */
export class TerminalControlHub {
  readonly paneId: string;
  readonly ready: Promise<void>;
  readonly windowId: string;

  #availableHistory = 0;
  #canonicalInitialization: Promise<void> | undefined;
  #canonicalModel: TerminalCanonicalModel;
  #closed = false;
  #commandBlock: ControlCommandBlock | undefined;
  #control: ChildProcessWithoutNullStreams;
  #controlLineBuffer = Buffer.alloc(0);
  #decoder = new TextDecoder();
  #loadedHistory = 0;
  #outputVersion = 0;
  #pendingCanonicalOutputBytes = 0;
  #pendingCanonicalOutputOperations = 0;
  #pendingCommands: PendingControlCommand[] = [];
  #operationQueue: Promise<void> = Promise.resolve();
  #readyReject!: (reason: unknown) => void;
  #readyResolve!: () => void;
  #sizeOwner: object | undefined;
  #subscribers = new Set<TerminalControlHubSubscriber>();

  constructor(windowId: string, paneId: string, geometry: CanonicalTerminalGeometry) {
    this.windowId = windowId;
    this.paneId = paneId;
    // Deep history is loaded lazily from tmux. Keep only the live viewport
    // until a subscriber explicitly asks to scroll upward.
    this.#canonicalModel = new TerminalCanonicalModel(geometry, { scrollback: 0 });
    this.#control = spawn('tmux', ['-C', 'attach-session', '-f', 'ignore-size', '-t', windowId], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#control.stderr.resume();
    this.ready = new Promise<void>((resolve, reject) => {
      this.#readyResolve = resolve;
      this.#readyReject = reject;
    });
    const attachmentTimer = setTimeout(() => {
      const error = new Error('tmux control client did not attach in time.');
      this.#readyReject(error);
      this.#fail(error);
    }, CONTROL_ATTACH_TIMEOUT_MS);
    void this.ready.then(
      () => clearTimeout(attachmentTimer),
      () => clearTimeout(attachmentTimer)
    );
    this.#installControlListeners();
  }

  get availableHistory(): number {
    return this.#availableHistory;
  }

  get closed(): boolean {
    return this.#closed;
  }

  get loadedHistory(): number {
    return this.#loadedHistory;
  }

  get outputVersion(): number {
    return this.#outputVersion;
  }

  subscribe(subscriber: TerminalControlHubSubscriber): () => void {
    if (this.#closed) {
      queueMicrotask(() => {
        try {
          subscriber.onUnavailable(new Error('tmux control client is unavailable.'));
        } catch {
          // A failed subscriber must never escape into the shared hub.
        }
      });
      return () => undefined;
    }
    this.#subscribers.add(subscriber);
    return () => this.#subscribers.delete(subscriber);
  }

  runCommand(command: string, onSuccess?: (output: string) => void): Promise<string> {
    return new Promise((resolve, reject) => {
      if (this.#closed || this.#control.exitCode !== null) {
        reject(new Error('tmux control client is unavailable.'));
        return;
      }
      const pending: PendingControlCommand = {
        resolve,
        reject,
        onSuccess,
        timer: setTimeout(() => {
          pending.reject(new Error('tmux control command timed out.'));
          this.#fail(new Error('tmux control command timed out.'));
        }, CONTROL_COMMAND_TIMEOUT_MS),
      };
      this.#pendingCommands.push(pending);
      this.#control.stdin.write(`${command}\n`, (error) => {
        if (!error) return;
        clearTimeout(pending.timer);
        const index = this.#pendingCommands.indexOf(pending);
        if (index >= 0) this.#pendingCommands.splice(index, 1);
        reject(error);
      });
    });
  }

  ensureCanonical(initializer: () => Promise<TerminalControlHubInitialization>): Promise<void> {
    this.#canonicalInitialization ??= (async () => {
      await this.ready;
      const initialized = await initializer();
      this.#availableHistory = initialized.availableHistory;
      this.#loadedHistory = initialized.loadedHistory;
    })().catch((error) => {
      this.#fail(error instanceof Error ? error : new Error('Canonical terminal initialization failed.'));
      throw error;
    });
    return this.#canonicalInitialization;
  }

  extendCanonicalHistory(
    requestedHistory: number,
    refresher: () => Promise<TerminalControlHubInitialization>
  ): Promise<void> {
    return (async () => {
      await this.#canonicalInitialization;
      if (this.#loadedHistory >= requestedHistory) return;
      const refreshed = await refresher();
      this.#availableHistory = refreshed.availableHistory;
      this.#loadedHistory = refreshed.loadedHistory;
    })();
  }

  runOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operationQueue
      .catch(() => undefined)
      .then(() => {
        if (this.#closed) throw new Error('tmux control client is unavailable.');
        return operation();
      });
    this.#operationQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  restoreCanonical(
    data: string,
    geometry: CanonicalTerminalGeometry,
    loadedHistory = this.#loadedHistory
  ): Promise<CanonicalTerminalSnapshot> {
    return this.#canonicalModel.restore(data, geometry, undefined, loadedHistory);
  }

  async snapshot(scrollback: number): Promise<CanonicalTerminalSnapshot> {
    await this.#canonicalInitialization;
    const snapshot = await this.#canonicalModel.snapshot(scrollback);
    return {
      ...snapshot,
      availableHistory: Math.max(snapshot.availableHistory, this.#availableHistory),
    };
  }

  resizeCanonical(geometry: CanonicalTerminalGeometry): Promise<CanonicalTerminalSnapshot> {
    return this.#canonicalModel.resize(geometry);
  }

  claimSize(owner: object): boolean {
    const hadOwner = this.#sizeOwner !== undefined;
    this.#sizeOwner = owner;
    return !hadOwner;
  }

  releaseSize(owner: object): boolean {
    if (this.#sizeOwner !== owner) return false;
    this.#sizeOwner = undefined;
    return true;
  }

  ownsSize(owner: object): boolean {
    return this.#sizeOwner === owner;
  }

  dispose(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectControlCommands(new Error('tmux control client is unavailable.'));
    this.#controlLineBuffer = Buffer.alloc(0);
    this.#control.stdin.end();
    this.#control.kill();
    this.#subscribers.clear();
    void this.#canonicalModel.dispose();
  }

  #installControlListeners(): void {
    this.#control.stdout.on('data', (chunk: Buffer) => {
      const buffer = this.#controlLineBuffer.length > 0 ? Buffer.concat([this.#controlLineBuffer, chunk]) : chunk;
      let lineStart = 0;
      for (let index = 0; index < buffer.length; index += 1) {
        if (buffer[index] !== 0x0a) continue;
        if (index - lineStart > MAX_TMUX_CONTROL_LINE_BYTES) {
          this.#fail(new Error('tmux control record exceeded its byte limit.'));
          return;
        }
        this.#handleControlLine(buffer.subarray(lineStart, index));
        if (this.#closed) return;
        lineStart = index + 1;
      }
      this.#controlLineBuffer = lineStart === buffer.length ? Buffer.alloc(0) : Buffer.from(buffer.subarray(lineStart));
      if (this.#controlLineBuffer.length > MAX_TMUX_CONTROL_LINE_BYTES)
        this.#fail(new Error('tmux control record exceeded its byte limit.'));
    });
    this.#control.once('error', (error) => this.#fail(error));
    this.#control.stdin.on('error', (error) => this.#fail(error));
    this.#control.once('exit', () => this.#fail(new Error('tmux control client exited.')));
  }

  #handleControlLine(lineBuffer: Buffer): void {
    const output = parseTmuxControlOutput(lineBuffer, this.paneId, this.#decoder);
    if (output !== undefined) {
      this.#outputVersion += 1;
      const bytes = Buffer.byteLength(output);
      this.#pendingCanonicalOutputBytes += bytes;
      this.#pendingCanonicalOutputOperations += 1;
      if (
        this.#pendingCanonicalOutputBytes > MAX_PENDING_CANONICAL_OUTPUT_BYTES ||
        this.#pendingCanonicalOutputOperations > MAX_PENDING_CANONICAL_OUTPUT_OPERATIONS
      ) {
        this.#fail(new Error('Canonical terminal parser fell behind.'));
        return;
      }
      void this.#canonicalModel
        .write(output)
        .then((entry) => {
          this.#pendingCanonicalOutputBytes -= bytes;
          this.#pendingCanonicalOutputOperations -= 1;
          if (!entry || this.#closed) return;
          for (const subscriber of this.#subscribers) {
            try {
              subscriber.onOutput(entry);
            } catch (error) {
              this.#subscribers.delete(subscriber);
              try {
                subscriber.onUnavailable(
                  error instanceof Error ? error : new Error('Terminal subscriber failed while receiving output.')
                );
              } catch {
                // Isolate a broken socket callback from every other subscriber.
              }
            }
          }
        })
        .catch((error) => this.#fail(error instanceof Error ? error : new Error('Terminal parser failed.')));
      return;
    }
    const line = lineBuffer.toString('utf8');
    if (line.startsWith('%begin ')) {
      this.#commandBlock = { command: this.#pendingCommands.shift(), output: [] };
      return;
    }
    if (this.#commandBlock) {
      if (line.startsWith('%end ') || line.startsWith('%error ')) {
        const completed = this.#commandBlock;
        this.#commandBlock = undefined;
        if (!completed.command) return;
        clearTimeout(completed.command.timer);
        if (line.startsWith('%error ')) {
          completed.command.reject(new Error(completed.output.join('\n') || 'tmux command failed.'));
          return;
        }
        const outputValue = completed.output.length > 0 ? `${completed.output.join('\n')}\n` : '';
        try {
          completed.command.onSuccess?.(outputValue);
          completed.command.resolve(outputValue);
        } catch (error) {
          completed.command.reject(error);
        }
        return;
      }
      completedOutput(this.#commandBlock, line);
      return;
    }
    if (line.startsWith('%session-changed ')) this.#readyResolve();
  }

  #rejectControlCommands(error: Error): void {
    this.#readyReject(error);
    if (this.#commandBlock?.command) {
      clearTimeout(this.#commandBlock.command.timer);
      this.#commandBlock.command.reject(error);
    }
    this.#commandBlock = undefined;
    for (const command of this.#pendingCommands.splice(0)) {
      clearTimeout(command.timer);
      command.reject(error);
    }
  }

  #fail(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectControlCommands(error);
    this.#controlLineBuffer = Buffer.alloc(0);
    this.#control.stdin.end();
    this.#control.kill();
    for (const subscriber of this.#subscribers) {
      try {
        subscriber.onUnavailable(error);
      } catch {
        // Hub failure notification is best-effort per subscriber.
      }
    }
    this.#subscribers.clear();
    void this.#canonicalModel.dispose();
  }
}

function completedOutput(block: ControlCommandBlock, line: string): void {
  block.output.push(line);
}

export function retainTerminalControlHub(
  tmuxSession: string,
  windowId: string,
  paneId: string,
  geometry: CanonicalTerminalGeometry
): TerminalControlHubLease {
  const key = terminalControlHubKey(tmuxSession, paneId);
  let entry = terminalControlHubs.get(key);
  if (!entry || entry.hub.closed) {
    if (entry?.hub.closed) terminalControlHubs.delete(key);
    for (const [idleKey, idleEntry] of terminalControlHubs) {
      if (terminalControlHubs.size < MAX_TERMINAL_CONTROL_HUBS) break;
      if (idleEntry.references > 0) continue;
      if (idleEntry.disposalTimer) clearTimeout(idleEntry.disposalTimer);
      idleEntry.hub.dispose();
      terminalControlHubs.delete(idleKey);
    }
    if (terminalControlHubs.size >= MAX_TERMINAL_CONTROL_HUBS) throw new Error('Too many terminal panes are active.');
    entry = {
      hub: new TerminalControlHub(windowId, paneId, geometry),
      references: 0,
    };
    terminalControlHubs.set(key, entry);
  }
  if (entry.hub.windowId !== windowId) throw new Error('Terminal pane moved to an unexpected window.');
  if (entry.disposalTimer) clearTimeout(entry.disposalTimer);
  entry.disposalTimer = undefined;
  entry.references += 1;
  let released = false;
  return {
    hub: entry.hub,
    release: () => {
      if (released) return;
      released = true;
      entry.references = Math.max(0, entry.references - 1);
      if (entry.references > 0 || entry.disposalTimer) return;
      entry.disposalTimer = setTimeout(() => {
        entry.disposalTimer = undefined;
        if (entry.references > 0) return;
        entry.hub.dispose();
        if (terminalControlHubs.get(key) === entry) terminalControlHubs.delete(key);
      }, HUB_RECONNECT_LINGER_MS);
      entry.disposalTimer.unref();
    },
  };
}

export function closeTerminalControlHubs(): void {
  for (const entry of terminalControlHubs.values()) {
    if (entry.disposalTimer) clearTimeout(entry.disposalTimer);
    entry.hub.dispose();
  }
  terminalControlHubs.clear();
}
