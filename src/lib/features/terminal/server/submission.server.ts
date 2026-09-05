import {
  TERMINAL_SUBMISSION_FAILURE_MESSAGE_MAX_LENGTH,
  type TerminalSubmissionResult,
} from '~/lib/shared/contracts/terminal-protocol.ts';

const BRACKETED_SUBMIT_SETTLE_MS = 20;
const UNBRACKETED_SUBMIT_SETTLE_MS = 140;
export const MAX_TRACKED_TERMINAL_SUBMISSIONS = 256;

type TerminalSubmissionRecord = { state: 'pending' } | { state: 'settled'; result: TerminalSubmissionResult };

export type TerminalSubmissionRegistration =
  | { state: 'started' }
  | { state: 'pending' }
  | { state: 'settled'; result: TerminalSubmissionResult }
  | { state: 'full' };

export class TerminalSubmissionLedger {
  readonly #maximumRecords: number;
  readonly #records = new Map<string, TerminalSubmissionRecord>();

  constructor(maximumRecords = MAX_TRACKED_TERMINAL_SUBMISSIONS) {
    if (!Number.isInteger(maximumRecords) || maximumRecords < 1) {
      throw new RangeError('Terminal submission record limit must be a positive integer.');
    }
    this.#maximumRecords = maximumRecords;
  }

  get size(): number {
    return this.#records.size;
  }

  register(requestId: string): TerminalSubmissionRegistration {
    const existing = this.#records.get(requestId);
    if (existing?.state === 'pending') return { state: 'pending' };
    if (existing?.state === 'settled') return { state: 'settled', result: existing.result };

    if (this.#records.size >= this.#maximumRecords) {
      for (const [recordId, record] of this.#records) {
        if (record.state !== 'settled') continue;
        this.#records.delete(recordId);
        break;
      }
    }
    if (this.#records.size >= this.#maximumRecords) return { state: 'full' };

    this.#records.set(requestId, { state: 'pending' });
    return { state: 'started' };
  }

  settle(result: TerminalSubmissionResult): boolean {
    if (this.#records.get(result.requestId)?.state !== 'pending') return false;
    this.#records.set(result.requestId, { state: 'settled', result });
    return true;
  }
}

export interface TerminalSubmissionOperations {
  inputAllowed: () => boolean;
  sendInput: (data: string) => Promise<void>;
  sendEnter: () => Promise<void>;
  wait?: (durationMs: number) => Promise<void>;
}

export function terminalSubmissionData(data: string, bracketedPaste: boolean): string {
  const normalized = data.replace(/\r?\n/g, '\r');
  return bracketedPaste ? `\u001b[200~${normalized}\u001b[201~` : normalized;
}

export function terminalSubmissionSettleMs(bracketedPaste: boolean): number {
  return bracketedPaste ? BRACKETED_SUBMIT_SETTLE_MS : UNBRACKETED_SUBMIT_SETTLE_MS;
}

export async function executeTerminalSubmission(
  data: string,
  bracketedPaste: boolean,
  operations: TerminalSubmissionOperations
): Promise<boolean> {
  if (!operations.inputAllowed()) return false;
  await operations.sendInput(terminalSubmissionData(data, bracketedPaste));
  if (!operations.inputAllowed()) return false;
  await (operations.wait ?? ((durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs))))(
    terminalSubmissionSettleMs(bracketedPaste)
  );
  if (!operations.inputAllowed()) return false;
  await operations.sendEnter();
  return true;
}

export function terminalSubmissionFailureMessage(error: unknown): string {
  const message = error instanceof Error && error.message.trim() ? error.message.trim() : 'Terminal submission failed.';
  return message.slice(0, TERMINAL_SUBMISSION_FAILURE_MESSAGE_MAX_LENGTH);
}
