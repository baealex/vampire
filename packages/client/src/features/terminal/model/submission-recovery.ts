import { configure, makeAutoObservable } from 'mobx';

configure({ enforceActions: 'never' });

function stateValue<T>(value: T): T {
  return value;
}

import {
  TerminalSubmissionTracker,
  type TerminalTrackedSubmission,
} from '@vampire/lib/features/terminal/model/submission-tracker.ts';
import {
  encodeTerminalClientMessage,
  TERMINAL_CLIENT_MESSAGE_LIMIT_BYTES,
  TERMINAL_INPUT_LIMIT_BYTES,
  type TerminalSubmissionResult,
} from '@vampire/lib/shared/contracts/terminal-protocol.ts';

const memoryRecovery = new Map<string, TerminalTrackedSubmission[]>();
const MAXIMUM_RETAINED_MESSAGES = 32;
type RecoveryStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function terminalSessionKey(workspaceId: string, terminalId?: string): string {
  return JSON.stringify([workspaceId, terminalId ?? null]);
}

/** Browser recovery only. Recording an attempt never retries terminal input. */
export class SubmissionRecovery {
  entries = stateValue<TerminalTrackedSubmission[]>([]);
  error = stateValue('');
  persistenceFailed = stateValue(false);
  #tracker: TerminalSubmissionTracker;
  #key: string;
  #storage: RecoveryStorage | undefined;

  constructor(workspaceId: string, terminalId?: string, storage?: RecoveryStorage) {
    this.#key = `vampire:submission-recovery:v1:${terminalSessionKey(workspaceId, terminalId)}`;
    let saved: unknown = memoryRecovery.get(this.#key);
    try {
      // Each tab owns a different socket and acknowledgement stream. A shared
      // localStorage array would let one tab erase another tab's pending draft.
      this.#storage = storage ?? window.sessionStorage;
      const raw = this.#storage.getItem(this.#key);
      if (raw && !memoryRecovery.has(this.#key)) saved = JSON.parse(raw);
    } catch {
      this.persistenceFailed = true;
    }
    this.#tracker = new TerminalSubmissionTracker({ initialEntries: saved });
    this.#publish();
    makeAutoObservable(this, {}, { autoBind: true });
  }

  submit(data: string, draft: string, send: (data: string, requestId: string) => boolean): boolean {
    this.error = '';
    if (this.entries.length >= MAXIMUM_RETAINED_MESSAGES) {
      this.error = 'Restore or dismiss an earlier unconfirmed message before sending another.';
      return false;
    }
    // getRandomValues also works on self-hosted HTTP origins where browsers
    // do not expose the secure-context-only randomUUID convenience method.
    const requestId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    const encoder = new TextEncoder();
    const encoded = encodeTerminalClientMessage({ type: 'submit', data, requestId, bracketedPaste: false });
    if (
      encoder.encode(data).byteLength > TERMINAL_INPUT_LIMIT_BYTES ||
      encoder.encode(encoded).byteLength > TERMINAL_CLIENT_MESSAGE_LIMIT_BYTES
    ) {
      this.error = 'This message is too large. Shorten it before sending. Your draft has been kept.';
      return false;
    }
    if (!this.#tracker.track({ requestId, draft })) return false;
    // Save the raw draft before the transport accepts anything.
    this.#publish();
    let sent = false;
    try {
      sent = send(data, requestId);
    } catch {
      sent = false;
    }
    if (sent) return true;
    this.#tracker.dismiss(requestId);
    this.error = 'The terminal is not ready. Your draft has been kept.';
    this.#publish();
    return false;
  }

  applyResult(result: TerminalSubmissionResult): void {
    if (this.#tracker.applyResult(result)) this.#publish();
  }

  markUncertain(requestId?: string): void {
    const message = requestId
      ? 'The terminal has not confirmed this message. Check it before sending again.'
      : 'The connection ended before confirmation. Check the terminal before sending again.';
    if (this.#tracker.markUncertain(requestId, message)) this.#publish();
  }

  dismiss(requestId: string): void {
    if (this.#tracker.dismiss(requestId)) {
      this.error = '';
      this.#publish();
    }
  }

  #publish(): void {
    this.entries = this.#tracker.entries;
    memoryRecovery.delete(this.#key);
    memoryRecovery.set(this.#key, this.entries);
    while (memoryRecovery.size > 32) {
      // Empty tombstones prevent stale storage from resurrecting dismissed
      // records, but must not displace drafts when many empty tabs are visited.
      const empty = Array.from(memoryRecovery).find(([, entries]) => entries.length === 0);
      memoryRecovery.delete(empty?.[0] ?? memoryRecovery.keys().next().value!);
    }
    try {
      if (!this.#storage) return;
      if (this.entries.length) this.#storage.setItem(this.#key, JSON.stringify(this.entries));
      else this.#storage.removeItem(this.#key);
      this.persistenceFailed = false;
    } catch {
      this.persistenceFailed = true;
    }
  }
}
