import { isTerminalSubmissionRequestId, parseTerminalServerMessage } from '~/lib/shared/contracts/terminal-protocol.ts';

export const TERMINAL_SUBMISSION_ACKNOWLEDGEMENT_TIMEOUT_MS = 30_000;
export const MAX_PENDING_TERMINAL_SUBMISSIONS = 32;
export const MAX_RECOVERABLE_TERMINAL_SUBMISSIONS = 32;

const DISCONNECTED_MESSAGE = 'The connection closed before the server confirmed this submission.';
const EXPIRED_MESSAGE = 'The server did not confirm this submission before the acknowledgement timeout.';
const RESTORED_PENDING_MESSAGE = 'Vampire restarted before the server confirmed this submission.';

interface TerminalTrackedSubmissionBase {
  readonly requestId: string;
  readonly draft: string;
  readonly submittedAt: number;
}

export interface TerminalPendingSubmission extends TerminalTrackedSubmissionBase {
  readonly status: 'pending';
  readonly acknowledgementDeadlineAt: number;
}

export interface TerminalRecoverableSubmission extends TerminalTrackedSubmissionBase {
  readonly status: 'failed' | 'uncertain';
  readonly message: string;
  readonly updatedAt: number;
  readonly deliveryMayHaveOccurred: true;
}

export type TerminalTrackedSubmission = TerminalPendingSubmission | TerminalRecoverableSubmission;

export interface TrackTerminalSubmission {
  requestId: string;
  draft: string;
  submittedAt?: number;
}

export interface TerminalSubmissionTrackerOptions {
  acknowledgementTimeoutMs?: number;
  initialEntries?: unknown;
  maximumPending?: number;
  maximumRecoverable?: number;
  now?: () => number;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function restoredSubmission(value: unknown): TerminalTrackedSubmission | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    !isTerminalSubmissionRequestId(record.requestId) ||
    typeof record.draft !== 'string' ||
    !isTimestamp(record.submittedAt)
  ) {
    return undefined;
  }
  const base = {
    requestId: record.requestId,
    draft: record.draft,
    submittedAt: record.submittedAt,
  };
  if (record.status === 'pending' && isTimestamp(record.acknowledgementDeadlineAt)) {
    return { ...base, status: record.status, acknowledgementDeadlineAt: record.acknowledgementDeadlineAt };
  }
  if (
    (record.status === 'failed' || record.status === 'uncertain') &&
    typeof record.message === 'string' &&
    record.message.length > 0 &&
    isTimestamp(record.updatedAt)
  ) {
    return {
      ...base,
      status: record.status,
      message: record.message,
      updatedAt: record.updatedAt,
      deliveryMayHaveOccurred: true,
    };
  }
  return undefined;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer.`);
  return value;
}

function positiveDuration(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError('Terminal submission acknowledgement timeout must be positive.');
  }
  return value;
}

export class TerminalSubmissionTracker {
  readonly #acknowledgementTimeoutMs: number;
  readonly #entries = new Map<string, TerminalTrackedSubmission>();
  readonly #maximumPending: number;
  readonly #maximumRecoverable: number;
  readonly #now: () => number;

  constructor(options: TerminalSubmissionTrackerOptions = {}) {
    this.#acknowledgementTimeoutMs = positiveDuration(
      options.acknowledgementTimeoutMs ?? TERMINAL_SUBMISSION_ACKNOWLEDGEMENT_TIMEOUT_MS
    );
    this.#maximumPending = positiveInteger(
      options.maximumPending ?? MAX_PENDING_TERMINAL_SUBMISSIONS,
      'Terminal pending submission limit'
    );
    this.#maximumRecoverable = positiveInteger(
      options.maximumRecoverable ?? MAX_RECOVERABLE_TERMINAL_SUBMISSIONS,
      'Terminal recoverable submission limit'
    );
    this.#now = options.now ?? Date.now;
    if (options.initialEntries !== undefined) this.restore(options.initialEntries);
  }

  get entries(): TerminalTrackedSubmission[] {
    return Array.from(this.#entries.values(), (entry) => ({ ...entry }));
  }

  get pendingCount(): number {
    let count = 0;
    for (const entry of this.#entries.values()) {
      if (entry.status === 'pending') count += 1;
    }
    return count;
  }

  track(submission: TrackTerminalSubmission, trackedAt = this.#now()): boolean {
    if (
      !isTerminalSubmissionRequestId(submission.requestId) ||
      typeof submission.draft !== 'string' ||
      !isTimestamp(trackedAt) ||
      this.#entries.has(submission.requestId) ||
      this.pendingCount >= this.#maximumPending
    ) {
      return false;
    }
    const submittedAt = submission.submittedAt ?? trackedAt;
    if (!isTimestamp(submittedAt)) return false;
    this.#entries.set(submission.requestId, {
      requestId: submission.requestId,
      draft: submission.draft,
      submittedAt,
      status: 'pending',
      acknowledgementDeadlineAt: trackedAt + this.#acknowledgementTimeoutMs,
    });
    return true;
  }

  applyResult(value: unknown, updatedAt = this.#now()): boolean {
    if (!isTimestamp(updatedAt)) return false;
    const result = parseTerminalServerMessage(value);
    if (result?.type !== 'submission-result') return false;
    const previous = this.#entries.get(result.requestId);
    if (!previous) return false;
    if (result.status === 'completed') {
      this.#entries.delete(result.requestId);
      return true;
    }
    this.#entries.delete(result.requestId);
    this.#entries.set(result.requestId, {
      requestId: previous.requestId,
      draft: previous.draft,
      submittedAt: previous.submittedAt,
      status: 'failed',
      message: result.message,
      updatedAt,
      deliveryMayHaveOccurred: true,
    });
    this.#trimRecoverable();
    return true;
  }

  markUncertain(requestId?: string, message = DISCONNECTED_MESSAGE, updatedAt = this.#now()): number {
    if (!isTimestamp(updatedAt) || !message) return 0;
    const pending = Array.from(this.#entries.values()).filter(
      (entry): entry is TerminalPendingSubmission =>
        entry.status === 'pending' && (requestId === undefined || entry.requestId === requestId)
    );
    for (const entry of pending) {
      this.#entries.delete(entry.requestId);
      this.#entries.set(entry.requestId, {
        requestId: entry.requestId,
        draft: entry.draft,
        submittedAt: entry.submittedAt,
        status: 'uncertain',
        message,
        updatedAt,
        deliveryMayHaveOccurred: true,
      });
    }
    this.#trimRecoverable();
    return pending.length;
  }

  markDisconnected(updatedAt = this.#now()): number {
    return this.markUncertain(undefined, DISCONNECTED_MESSAGE, updatedAt);
  }

  expire(updatedAt = this.#now()): number {
    if (!isTimestamp(updatedAt)) return 0;
    const expiredRequestIds = Array.from(this.#entries.values())
      .filter(
        (entry): entry is TerminalPendingSubmission =>
          entry.status === 'pending' && entry.acknowledgementDeadlineAt <= updatedAt
      )
      .map((entry) => entry.requestId);
    let changed = 0;
    for (const requestId of expiredRequestIds) {
      changed += this.markUncertain(requestId, EXPIRED_MESSAGE, updatedAt);
    }
    return changed;
  }

  dismiss(requestId: string): boolean {
    return this.#entries.delete(requestId);
  }

  restore(value: unknown, restoredAt = this.#now()): number {
    this.#entries.clear();
    if (!Array.isArray(value) || !isTimestamp(restoredAt)) return 0;
    for (const candidate of value) {
      const entry = restoredSubmission(candidate);
      if (!entry || this.#entries.has(entry.requestId)) continue;
      if (entry.status === 'pending') {
        this.#entries.set(entry.requestId, {
          requestId: entry.requestId,
          draft: entry.draft,
          submittedAt: entry.submittedAt,
          status: 'uncertain',
          message: RESTORED_PENDING_MESSAGE,
          updatedAt: restoredAt,
          deliveryMayHaveOccurred: true,
        });
      } else {
        this.#entries.set(entry.requestId, entry);
      }
      this.#trimRecoverable();
    }
    return this.#entries.size;
  }

  #trimRecoverable(): void {
    let recoverableCount = 0;
    for (const entry of this.#entries.values()) {
      if (entry.status !== 'pending') recoverableCount += 1;
    }
    if (recoverableCount <= this.#maximumRecoverable) return;
    for (const [requestId, entry] of this.#entries) {
      if (entry.status === 'pending') continue;
      this.#entries.delete(requestId);
      recoverableCount -= 1;
      if (recoverableCount <= this.#maximumRecoverable) return;
    }
  }
}
