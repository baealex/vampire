import { isTerminalColorSlot, isTerminalRgbColor, type TerminalColorSlot } from './terminal-color.ts';

export interface TerminalHistoryState {
  loaded: number;
  available: number;
}

export type TerminalSubmissionResult =
  | { type: 'submission-result'; requestId: string; status: 'completed' }
  | { type: 'submission-result'; requestId: string; status: 'failed'; message: string };

export type TerminalClientMessage =
  | { type: 'activate' }
  | { type: 'snapshot-ready'; snapshotId?: number }
  | { type: 'load-history'; lines: number }
  | { type: 'input'; data: string }
  | { type: 'submit'; data: string; bracketedPaste: boolean; requestId?: string }
  | { type: 'terminal-color'; slot: TerminalColorSlot; color: string }
  | { type: 'resize'; columns: number; rows: number };

export type TerminalServerMessage =
  | {
      type: 'snapshot';
      data: string;
      history?: TerminalHistoryState;
      snapshotId?: number;
      throughSequence?: number;
    }
  | { type: 'geometry'; columns: number; rows: number; active?: boolean }
  | { type: 'request-terminal-theme' }
  | { type: 'screen-ready' }
  | {
      type: 'output';
      data: string;
      activity: boolean;
      activityAt: number | null;
      screenSync?: boolean;
      reset?: boolean;
      history?: TerminalHistoryState;
      sequence?: number;
      throughSequence?: number;
    }
  | { type: 'repository-status'; changeCount: number; worktreeCount: number; branch?: string }
  | TerminalSubmissionResult
  | { type: 'error'; message: string };

export const TERMINAL_GEOMETRY_PROTOCOL_VERSION = 2;
export const TERMINAL_RESET_SCREEN_SYNC_PROTOCOL_VERSION = 3;
export const TERMINAL_SNAPSHOT_ID_PROTOCOL_VERSION = 4;
export const TERMINAL_OUTPUT_SEQUENCE_PROTOCOL_VERSION = 5;
export const TERMINAL_SUBMISSION_RESULT_PROTOCOL_VERSION = 6;
export const TERMINAL_PROTOCOL_VERSION = 6;
export const TERMINAL_INPUT_LIMIT_BYTES = 64 * 1024;
export const TERMINAL_CLIENT_MESSAGE_LIMIT_BYTES = 72 * 1024;

export const TERMINAL_SUBMISSION_REQUEST_ID_MAX_LENGTH = 128;
export const TERMINAL_SUBMISSION_FAILURE_MESSAGE_MAX_LENGTH = 1_024;

export const TERMINAL_SIZE_LIMITS = {
  minimumColumns: 20,
  maximumColumns: 512,
  minimumRows: 5,
  maximumRows: 256,
};

export const TERMINAL_GEOMETRY_LIMITS = {
  minimumColumns: 1,
  maximumColumns: 1_000,
  minimumRows: 1,
  maximumRows: 500,
};

export const TERMINAL_SCROLLBACK_LINES = {
  reduced: 4_000,
  standard: 10_000,
} as const;

export const TERMINAL_HISTORY_CHUNK_LINES = {
  reduced: 250,
  standard: 500,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isIntegerBetween(value: unknown, minimum: number, maximum: number): boolean {
  return Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

export function isTerminalSubmissionRequestId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= TERMINAL_SUBMISSION_REQUEST_ID_MAX_LENGTH &&
    /^[A-Za-z0-9][A-Za-z0-9._~-]*$/.test(value)
  );
}

export function parseTerminalClientMessage(value: unknown): TerminalClientMessage | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type === 'activate') return { type: value.type };
  if (
    value.type === 'snapshot-ready' &&
    (value.snapshotId === undefined || isIntegerBetween(value.snapshotId, 1, Number.MAX_SAFE_INTEGER))
  )
    return value.snapshotId === undefined
      ? { type: 'snapshot-ready' }
      : { type: 'snapshot-ready', snapshotId: Number(value.snapshotId) };
  if (value.type === 'load-history' && isIntegerBetween(value.lines, 1, TERMINAL_SCROLLBACK_LINES.standard))
    return { type: 'load-history', lines: Number(value.lines) };
  if (value.type === 'input' && typeof value.data === 'string') return { type: 'input', data: value.data };
  if (value.type === 'terminal-color' && isTerminalColorSlot(value.slot) && isTerminalRgbColor(value.color)) {
    return { type: 'terminal-color', slot: value.slot, color: value.color };
  }
  if (
    value.type === 'submit' &&
    typeof value.data === 'string' &&
    typeof value.bracketedPaste === 'boolean' &&
    (value.requestId === undefined || isTerminalSubmissionRequestId(value.requestId))
  ) {
    return {
      type: 'submit',
      data: value.data,
      bracketedPaste: value.bracketedPaste,
      ...(typeof value.requestId === 'string' ? { requestId: value.requestId } : {}),
    };
  }
  if (
    value.type === 'resize' &&
    isIntegerBetween(value.columns, TERMINAL_SIZE_LIMITS.minimumColumns, TERMINAL_SIZE_LIMITS.maximumColumns) &&
    isIntegerBetween(value.rows, TERMINAL_SIZE_LIMITS.minimumRows, TERMINAL_SIZE_LIMITS.maximumRows)
  ) {
    return { type: 'resize', columns: Number(value.columns), rows: Number(value.rows) };
  }
  return undefined;
}

export function parseTerminalServerMessage(value: unknown): TerminalServerMessage | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type === 'snapshot' && typeof value.data === 'string') {
    if (value.snapshotId !== undefined && !isIntegerBetween(value.snapshotId, 1, Number.MAX_SAFE_INTEGER))
      return undefined;
    const snapshotId = value.snapshotId === undefined ? {} : { snapshotId: Number(value.snapshotId) };
    if (value.throughSequence !== undefined && !isIntegerBetween(value.throughSequence, 0, Number.MAX_SAFE_INTEGER))
      return undefined;
    const throughSequence =
      value.throughSequence === undefined ? {} : { throughSequence: Number(value.throughSequence) };
    if (value.history === undefined) return { type: 'snapshot', data: value.data, ...snapshotId, ...throughSequence };
    if (
      !isRecord(value.history) ||
      !isIntegerBetween(value.history.loaded, 0, TERMINAL_SCROLLBACK_LINES.standard) ||
      !isIntegerBetween(value.history.available, 0, TERMINAL_SCROLLBACK_LINES.standard) ||
      Number(value.history.loaded) > Number(value.history.available)
    )
      return undefined;
    return {
      type: 'snapshot',
      data: value.data,
      ...snapshotId,
      ...throughSequence,
      history: {
        loaded: Number(value.history.loaded),
        available: Number(value.history.available),
      },
    };
  }
  if (
    value.type === 'geometry' &&
    isIntegerBetween(value.columns, TERMINAL_GEOMETRY_LIMITS.minimumColumns, TERMINAL_GEOMETRY_LIMITS.maximumColumns) &&
    isIntegerBetween(value.rows, TERMINAL_GEOMETRY_LIMITS.minimumRows, TERMINAL_GEOMETRY_LIMITS.maximumRows) &&
    (value.active === undefined || typeof value.active === 'boolean')
  ) {
    const geometry = { type: 'geometry' as const, columns: Number(value.columns), rows: Number(value.rows) };
    return value.active === undefined ? geometry : { ...geometry, active: value.active };
  }
  if (value.type === 'request-terminal-theme' || value.type === 'screen-ready') return { type: value.type };
  if (
    value.type === 'output' &&
    typeof value.data === 'string' &&
    typeof value.activity === 'boolean' &&
    (value.screenSync === undefined || typeof value.screenSync === 'boolean') &&
    (value.reset === undefined || typeof value.reset === 'boolean') &&
    ((value.activity && typeof value.activityAt === 'number' && Number.isFinite(value.activityAt)) ||
      (!value.activity && value.activityAt === null))
  ) {
    if (value.sequence !== undefined && !isIntegerBetween(value.sequence, 1, Number.MAX_SAFE_INTEGER)) return undefined;
    if (value.throughSequence !== undefined && !isIntegerBetween(value.throughSequence, 0, Number.MAX_SAFE_INTEGER))
      return undefined;
    if (value.sequence !== undefined && value.throughSequence !== undefined) return undefined;
    if (value.throughSequence !== undefined && value.screenSync !== true) return undefined;
    const history = value.history;
    if ((value.reset === true || history !== undefined) && value.screenSync !== true) return undefined;
    if (
      history !== undefined &&
      (!isRecord(history) ||
        !isIntegerBetween(history.loaded, 0, TERMINAL_SCROLLBACK_LINES.standard) ||
        !isIntegerBetween(history.available, 0, TERMINAL_SCROLLBACK_LINES.standard) ||
        Number(history.loaded) > Number(history.available))
    )
      return undefined;
    return {
      type: 'output',
      data: value.data,
      activity: value.activity,
      activityAt: value.activityAt,
      ...(value.screenSync === true ? { screenSync: true } : {}),
      ...(value.reset === true ? { reset: true } : {}),
      ...(history ? { history: { loaded: Number(history.loaded), available: Number(history.available) } } : {}),
      ...(value.sequence === undefined ? {} : { sequence: Number(value.sequence) }),
      ...(value.throughSequence === undefined ? {} : { throughSequence: Number(value.throughSequence) }),
    };
  }
  if (
    value.type === 'repository-status' &&
    Number.isInteger(value.changeCount) &&
    Number(value.changeCount) >= 0 &&
    Number.isInteger(value.worktreeCount) &&
    Number(value.worktreeCount) >= 0 &&
    (value.branch === undefined || typeof value.branch === 'string')
  ) {
    return {
      type: 'repository-status',
      changeCount: Number(value.changeCount),
      worktreeCount: Number(value.worktreeCount),
      ...(typeof value.branch === 'string' ? { branch: value.branch } : {}),
    };
  }
  if (value.type === 'submission-result' && isTerminalSubmissionRequestId(value.requestId)) {
    if (value.status === 'completed') {
      return { type: 'submission-result', requestId: value.requestId, status: value.status };
    }
    if (
      value.status === 'failed' &&
      typeof value.message === 'string' &&
      value.message.length > 0 &&
      value.message.length <= TERMINAL_SUBMISSION_FAILURE_MESSAGE_MAX_LENGTH
    ) {
      return {
        type: 'submission-result',
        requestId: value.requestId,
        status: value.status,
        message: value.message,
      };
    }
  }
  if (value.type === 'error' && typeof value.message === 'string') return { type: 'error', message: value.message };
  return undefined;
}

function decodeJsonMessage<T>(raw: unknown, parser: (value: unknown) => T | undefined): T | undefined {
  try {
    return parser(JSON.parse(typeof raw === 'string' ? raw : String(raw)));
  } catch {
    return undefined;
  }
}

export function decodeTerminalClientMessage(raw: unknown): TerminalClientMessage | undefined {
  return decodeJsonMessage(raw, parseTerminalClientMessage);
}

export function decodeTerminalServerMessage(raw: unknown): TerminalServerMessage | undefined {
  return decodeJsonMessage(raw, parseTerminalServerMessage);
}

export function encodeTerminalClientMessage(message: TerminalClientMessage): string {
  const parsed = parseTerminalClientMessage(message);
  if (!parsed) throw new TypeError('Invalid terminal client message.');
  return JSON.stringify(parsed);
}

export function encodeTerminalServerMessage(message: TerminalServerMessage): string {
  const parsed = parseTerminalServerMessage(message);
  if (!parsed) throw new TypeError('Invalid terminal server message.');
  return JSON.stringify(parsed);
}
