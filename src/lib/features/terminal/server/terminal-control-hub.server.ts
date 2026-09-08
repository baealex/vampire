import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import { parseTmuxControlOutput } from './tmux-control.server.ts';
import { tmuxCommandArguments } from '~/lib/server/tmux-command.ts';

const CONTROL_COMMAND_TIMEOUT_MS = 3_000;
const CONTROL_ATTACH_TIMEOUT_MS = 3_000;
const HUB_RECONNECT_LINGER_MS = 5_000;
const MAX_TERMINAL_CONTROL_HUBS = 32;
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

export interface TerminalControlHubOutput {
  sequence: number;
  data: string;
}

export interface TerminalControlHubGeometry {
  columns: number;
  rows: number;
}

export interface TerminalControlHubSubscriber {
  onOutput: (output: TerminalControlHubOutput) => void;
  onUnavailable: (error: Error) => void;
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
 * One tmux control client per pane, shared by every browser.
 *
 * This class intentionally does not emulate a terminal. `%output` bytes are
 * sequenced and fanned out immediately; snapshots are captured from tmux only
 * when a new attachment or an explicit recovery needs an authoritative frame.
 */
export class TerminalControlHub {
  readonly paneId: string;
  readonly ready: Promise<void>;
  readonly windowId: string;

  #closed = false;
  #commandBlock: ControlCommandBlock | undefined;
  #control: ChildProcessWithoutNullStreams;
  #controlLineBuffer = Buffer.alloc(0);
  #decoder = new TextDecoder();
  #nextOutputSequence = 0;
  #outputVersion = 0;
  #pendingCommands: PendingControlCommand[] = [];
  #operationQueue: Promise<void> = Promise.resolve();
  #readyReject!: (reason: unknown) => void;
  #readyResolve!: () => void;
  #sizeOwner: object | undefined;
  #subscribers = new Set<TerminalControlHubSubscriber>();

  constructor(windowId: string, paneId: string, geometry: TerminalControlHubGeometry) {
    this.windowId = windowId;
    this.paneId = paneId;
    // Geometry is still accepted here so the hub can share the same neutral
    // construction contract as the tmux pane. The browser xterm, not this
    // process, owns the terminal grid and scrollback.
    void geometry;
    this.#control = spawn('tmux', tmuxCommandArguments(['-C', 'attach-session', '-f', 'ignore-size', '-t', windowId]), {
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

  get closed(): boolean {
    return this.#closed;
  }

  get outputVersion(): number {
    return this.#outputVersion;
  }

  get outputSequence(): number {
    return this.#nextOutputSequence;
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
      if (!output) return;
      // Keep the browser on tmux's ordered output path. There is deliberately
      // no second terminal parser behind this callback.
      const liveOutput = { sequence: ++this.#nextOutputSequence, data: output };
      for (const subscriber of this.#subscribers) {
        try {
          subscriber.onOutput(liveOutput);
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
  }
}

function completedOutput(block: ControlCommandBlock, line: string): void {
  block.output.push(line);
}

export function retainTerminalControlHub(
  tmuxSession: string,
  windowId: string,
  paneId: string,
  geometry: TerminalControlHubGeometry
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
