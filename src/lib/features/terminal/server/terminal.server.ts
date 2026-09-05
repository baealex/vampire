import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import { tmuxCommandArguments } from '~/lib/server/tmux-command.ts';
import { type TerminalColorSlot, terminalColorReport } from '~/lib/shared/contracts/terminal-color.ts';
import {
  decodeTerminalClientMessage,
  encodeTerminalServerMessage,
  TERMINAL_GEOMETRY_LIMITS,
  TERMINAL_SCROLLBACK_LINES,
  TERMINAL_INPUT_LIMIT_BYTES,
  type TerminalHistoryState,
  type TerminalServerMessage,
  type TerminalSubmissionResult,
} from '~/lib/shared/contracts/terminal-protocol.ts';
import {
  executeTerminalSubmission,
  TerminalSubmissionLedger,
  terminalSubmissionFailureMessage,
} from './submission.server.ts';
import { retainTerminalControlHub } from './terminal-control-hub.server.ts';
import { type TerminalDeliveryBatch, TerminalDeliveryBuffer } from './terminal-delivery.server.ts';

export { terminalSubmissionData, terminalSubmissionSettleMs } from './submission.server.ts';
export { decodeTmuxControlValue, parseTmuxControlOutput } from './tmux-control.server.ts';

const execFile = promisify(execFileCallback);
const MAX_PENDING_INPUT_BYTES = 256 * 1024;
const TMUX_INPUT_CHUNK_BYTES = 4 * 1024;
const MAX_MESSAGES_PER_WINDOW = 600;
const MESSAGE_WINDOW_MS = 10_000;
const MAX_SNAPSHOT_OUTPUT_QUEUE_BYTES = 512 * 1024;
export const MAX_TERMINAL_SOCKET_BACKLOG_BYTES = 2 * 1024 * 1024;
export const MAX_TERMINAL_SCREEN_FRAME_BYTES = 8 * 1024 * 1024;
export const MAX_TERMINAL_ENCODED_SCREEN_DATA_BYTES = MAX_TERMINAL_SCREEN_FRAME_BYTES - 64 * 1024;
const TERMINAL_BACKPRESSURE_TERMINATE_MS = 1_000;
const SYNTHETIC_OUTPUT_SETTLE_MS = 150;
// This does not delay rendering. It prevents resize-generated redraw bytes from
// being classified as user-visible agent activity after tmux commands settle.
const TERMINAL_RESIZE_ACTIVITY_SUPPRESSION_MS = 1_000;
const TERMINAL_REDRAW_QUIET_MS = 40;
// A completed control-command barrier is followed by any deferred tmux redraw
// notification. Keep one conservative observation window, then require a full
// quiet interval after the latest output instead of imposing a fixed 250ms stall.
const TERMINAL_REDRAW_GRACE_MS = 64;
// A pane can emit one last resize redraw after the first authoritative screen
// has been captured. Keep the delivery gate closed across that paint window
// and replace the screen again if tmux produced anything in between.
const TERMINAL_POST_SYNCHRONIZATION_GRACE_MS = 150;
const TERMINAL_REDRAW_SETTLE_LIMIT_MS = 1_000;
const TERMINAL_REDRAW_POLL_MS = 10;
const TERMINAL_INITIAL_OUTPUT_WAIT_MS = 1_000;
const SYNTHETIC_OUTPUT_BARRIER = 'display-message -p vampire-redraw-barrier';
const TERMINAL_ALTERNATE_SCREEN_EXIT_SEQUENCES = ['\u001b[?47l', '\u001b[?1047l', '\u001b[?1049l'] as const;
const TERMINAL_CONTROL_SEQUENCE_TAIL_LENGTH =
  Math.max(...TERMINAL_ALTERNATE_SCREEN_EXIT_SEQUENCES.map((sequence) => sequence.length)) - 1;
const TERMINAL_PANE_STATE_FORMAT = [
  '#{alternate_on}',
  '#{alternate_saved_x}',
  '#{alternate_saved_y}',
  '#{bracket_paste_flag}',
  '#{cursor_flag}',
  '#{cursor_x}',
  '#{cursor_y}',
  '#{insert_flag}',
  '#{keypad_cursor_flag}',
  '#{keypad_flag}',
  '#{origin_flag}',
  '#{wrap_flag}',
  '#{scroll_region_upper}',
  '#{scroll_region_lower}',
].join('\t');
const terminalBackpressureTimers = new WeakMap<WebSocket, ReturnType<typeof setTimeout>>();

class TerminalScreenFrameTooLargeError extends Error {
  constructor() {
    super('Terminal screen is too large to synchronize safely.');
  }
}

export interface TerminalSize {
  columns: number;
  rows: number;
}

export interface TerminalCursorPosition {
  column: number;
  row: number;
}

export interface TerminalPaneState {
  alternateScreen: boolean;
  alternateSavedCursor: TerminalCursorPosition;
  bracketedPaste?: boolean;
  cursor: TerminalCursorPosition;
  cursorWrapPending: boolean;
  cursorVisible: boolean;
  insertMode: boolean;
  keypadApplicationMode: boolean;
  keypadCursorMode: boolean;
  originMode: boolean;
  scrollRegion: { top: number; bottom: number };
  wraparoundMode: boolean;
}

export interface TerminalAlternateScreenExitState {
  exited: boolean;
  tail: string;
}

export function terminalGeometryIsColumnJitter(previous: TerminalSize, next: TerminalSize): boolean {
  return previous.rows === next.rows && Math.abs(previous.columns - next.columns) === 1;
}

export type TerminalSizeController = (ignored: boolean) => Promise<void>;
export type TerminalScreenSynchronizer = (geometry?: TerminalSize) => Promise<void>;
export type TerminalOperationScheduler = <T>(operation: () => Promise<T>) => Promise<T>;

export interface AttachTerminalOptions {
  terminalId?: string;
  historyLines?: number;
  lazyHistory?: boolean;
  ignoreSize?: boolean;
  isAuthorized?: () => boolean;
  onAuthorizationRevoked?: (listener: () => void) => () => void;
  canResize?: () => boolean;
  canReportTerminalColor?: () => boolean;
  getGeometry?: () => TerminalSize | undefined;
  getGeometryRevision?: () => number;
  hasControl?: () => boolean;
  sendGeometry?: boolean;
  resetScreenSync?: boolean;
  snapshotIds?: boolean;
  outputSequences?: boolean;
  submissionResults?: boolean;
  scheduleOperation?: TerminalOperationScheduler;
  onAttached?: (
    setIgnoreSize: TerminalSizeController,
    synchronizeScreen: TerminalScreenSynchronizer
  ) => Promise<void> | void;
  onActivate?: () => Promise<void> | void;
  onGeometryChange?: (geometry: TerminalSize) => void;
  onResizeComplete?: (geometry: TerminalSize) => Promise<void> | void;
  onInput?: () => void;
  onSyntheticActivity?: (timestamp: number) => void;
  onSyntheticOutput?: (timestamp: number) => void;
  onSyntheticOutputGateChange?: (active: boolean) => void;
  isOutputSuppressed?: () => boolean;
  getInputVersion?: () => number;
  isOutputActivity?: (timestamp: number) => boolean;
  onOutputActivity?: (timestamp: number) => void;
}

export function terminalSnapshotHistoryLines(requested?: number): number {
  if (!Number.isInteger(requested) || Number(requested) <= 0) return TERMINAL_SCROLLBACK_LINES.standard;
  return Math.min(TERMINAL_SCROLLBACK_LINES.standard, Number(requested));
}

export function terminalAvailableHistoryLines(output: string, maximum: number): number {
  const value = Number(output.trim());
  if (!Number.isInteger(value) || value <= 0) return 0;
  return Math.min(maximum, value);
}

export function terminalAlternateScreenExitState(
  previousTail: string,
  output: string
): TerminalAlternateScreenExitState {
  const tail = previousTail.slice(-TERMINAL_CONTROL_SEQUENCE_TAIL_LENGTH);
  const combined = `${tail}${output}`;
  return {
    // Search only positions whose sequence would end in the new output. This
    // catches records split at any byte without detecting a short sequence from
    // the retained tail for a second time.
    exited: TERMINAL_ALTERNATE_SCREEN_EXIT_SEQUENCES.some(
      (sequence) => combined.indexOf(sequence, Math.max(0, tail.length - sequence.length + 1)) >= 0
    ),
    tail: combined.slice(-TERMINAL_CONTROL_SEQUENCE_TAIL_LENGTH),
  };
}

export function terminalPaneState(output: string, geometry: TerminalSize): TerminalPaneState | undefined {
  const value = output.endsWith('\n') ? output.slice(0, -1) : output;
  const fields = value.split('\t');
  if (fields.length !== 14) return undefined;
  const flag = (index: number): boolean | undefined => {
    if (fields[index] === '1') return true;
    if (fields[index] === '0') return false;
    return undefined;
  };
  const integer = (index: number): number | undefined => {
    if (!/^\d+$/.test(fields[index] ?? '')) return undefined;
    const parsed = Number(fields[index]);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  };
  const alternateScreen = flag(0);
  const alternateSavedColumn = integer(1);
  const alternateSavedRow = integer(2);
  // tmux 3.4 and older expand unknown formats to an empty field. Keep the
  // remaining pane state usable when bracket_paste_flag is unavailable.
  const bracketedPaste = fields[3] === '' ? undefined : flag(3);
  const cursorVisible = flag(4);
  const cursorColumn = integer(5);
  const cursorRow = integer(6);
  const insertMode = flag(7);
  const keypadCursorMode = flag(8);
  const keypadApplicationMode = flag(9);
  const originMode = flag(10);
  const wraparoundMode = flag(11);
  const scrollTop = integer(12);
  const scrollBottom = integer(13);
  if (
    alternateScreen === undefined ||
    alternateSavedColumn === undefined ||
    alternateSavedRow === undefined ||
    (fields[3] !== '' && bracketedPaste === undefined) ||
    cursorVisible === undefined ||
    cursorColumn === undefined ||
    cursorRow === undefined ||
    insertMode === undefined ||
    keypadCursorMode === undefined ||
    keypadApplicationMode === undefined ||
    originMode === undefined ||
    wraparoundMode === undefined ||
    scrollTop === undefined ||
    scrollBottom === undefined ||
    cursorColumn > geometry.columns ||
    cursorRow >= geometry.rows ||
    scrollTop >= geometry.rows ||
    scrollBottom >= geometry.rows ||
    scrollTop > scrollBottom ||
    (cursorColumn === geometry.columns && !wraparoundMode) ||
    (originMode && (cursorRow < scrollTop || cursorRow > scrollBottom))
  )
    return undefined;
  return {
    alternateScreen,
    // tmux keeps the saved main screen at its pre-alternate-screen geometry.
    // When the pane shrinks behind a TUI these coordinates can legitimately
    // exceed the active xterm grid. Clamp the provisional reconstruction; an
    // exit-triggered capture then replaces it with tmux's exact reflowed screen.
    alternateSavedCursor: {
      column: Math.min(alternateSavedColumn, geometry.columns - 1),
      row: Math.min(alternateSavedRow, geometry.rows - 1),
    },
    bracketedPaste,
    cursor: { column: Math.min(cursorColumn, geometry.columns - 1), row: cursorRow },
    cursorWrapPending: cursorColumn === geometry.columns,
    cursorVisible,
    insertMode,
    keypadApplicationMode,
    keypadCursorMode,
    originMode,
    scrollRegion: { top: scrollTop, bottom: scrollBottom },
    wraparoundMode,
  };
}

function terminalCursorData(cursor: TerminalCursorPosition, rowOffset = 0): string {
  return `\u001b[${cursor.row - rowOffset + 1};${cursor.column + 1}H`;
}

function terminalPaneModeData(state: TerminalPaneState, cursorRowOutput?: string): string {
  const { top, bottom } = state.scrollRegion;
  const applicationModes = [
    state.keypadCursorMode ? '\u001b[?1h' : '\u001b[?1l',
    state.keypadApplicationMode ? '\u001b=' : '\u001b>',
    state.bracketedPaste === undefined ? '' : state.bracketedPaste ? '\u001b[?2004h' : '\u001b[?2004l',
    state.wraparoundMode ? '\u001b[?7h' : '\u001b[?7l',
    `\u001b[${top + 1};${bottom + 1}r`,
    state.originMode ? '\u001b[?6h' : '\u001b[?6l',
  ].join('');
  const cursorVisibility = state.cursorVisible ? '\u001b[?25h' : '\u001b[?25l';
  if (state.cursorWrapPending && cursorRowOutput !== undefined) {
    // CUP clamps to the final visible column and cannot represent xterm's
    // pending-autowrap cursor. Rewriting the captured physical row leaves the
    // cursor one cell past its edge, matching tmux before the next character.
    return [
      '\u001b[4l',
      applicationModes,
      terminalCursorData({ column: 0, row: state.cursor.row }, state.originMode ? top : 0),
      '\u001b[0m',
      terminalRecordData(cursorRowOutput),
      state.insertMode ? '\u001b[4h' : '\u001b[4l',
      cursorVisibility,
    ].join('');
  }
  return [
    state.insertMode ? '\u001b[4h' : '\u001b[4l',
    applicationModes,
    terminalCursorData(state.cursor, state.originMode ? top : 0),
    cursorVisibility,
  ].join('');
}

function terminalRecordData(output: string): string {
  return output.endsWith('\n') ? output.slice(0, -1) : output;
}

function terminalPhysicalRowData(output: string, row: number): string | undefined {
  const value = terminalRecordData(output).split('\n')[row];
  return value === '' || value === undefined ? undefined : value;
}

const TERMINAL_CAPTURE_WRITE_MODE = '\u001b[0m\u001b[4l\u001b[?7h';

function terminalCaptureFlag(state: TerminalPaneState | undefined): '-J' | '-N' {
  // -J implies -T and drops trailing cells that may carry a background.
  return state?.alternateScreen ? '-N' : '-J';
}

function terminalPhysicalCaptureData(output: string): string {
  // -N returns physical rows; CR keeps each reconstructed row anchored at column 0.
  return output.replace(/\r?\n/gu, '\r\n');
}

export function terminalSnapshotData(
  output: string,
  state?: TerminalPaneState,
  savedMainOutput = '',
  physicalOutput = ''
): string {
  // runControlCommand terminates command output with a record separator newline.
  // Writing that separator into an exactly full xterm grid scrolls the screen by
  // one row. Remove only the separator; real trailing blank pane rows remain.
  const snapshot = terminalRecordData(output);
  if (!state) return snapshot;
  const cursorRowOutput = terminalPhysicalRowData(physicalOutput, state.cursor.row);
  if (!state.alternateScreen) return `${snapshot}${terminalPaneModeData(state, cursorRowOutput)}`;
  const mainScreen = terminalRecordData(savedMainOutput);
  return [
    mainScreen,
    '\u001b[?6l\u001b[r',
    terminalCursorData(state.alternateSavedCursor),
    `\u001b[?1049h${TERMINAL_CAPTURE_WRITE_MODE}`,
    snapshot,
    terminalPaneModeData(state, cursorRowOutput),
  ].join('');
}

export function terminalScreenData(
  output: string,
  state?: TerminalPaneState,
  savedMainOutput = '',
  physicalOutput = ''
): string {
  // Replace only the visible grid so browser scrollback survives a redraw.
  // Captures assume default rendition, insert off, and wrapping on; normalize
  // those modes while writing cells and restore the tmux pane modes afterward.
  const resetMainScreen = `\u001b[?1049l\u001b[?6l\u001b[r${TERMINAL_CAPTURE_WRITE_MODE}\u001b[2J\u001b[H`;
  if (!state?.alternateScreen) {
    return `${resetMainScreen}${terminalSnapshotData(output, state, '', physicalOutput)}`;
  }
  const cursorRowOutput = terminalPhysicalRowData(physicalOutput, state.cursor.row);
  return [
    resetMainScreen,
    terminalRecordData(savedMainOutput),
    terminalCursorData(state.alternateSavedCursor),
    `\u001b[?1049h${TERMINAL_CAPTURE_WRITE_MODE}\u001b[2J\u001b[H`,
    terminalRecordData(output),
    terminalPaneModeData(state, cursorRowOutput),
  ].join('');
}

export function* terminalInputControlCommands(paneId: string, data: string): Generator<string> {
  if (!/^%\d+$/.test(paneId)) throw new Error('Terminal pane identifier is invalid.');
  const input = Buffer.from(data);
  for (let offset = 0; offset < input.length; offset += TMUX_INPUT_CHUNK_BYTES) {
    const chunk = input.subarray(offset, offset + TMUX_INPUT_CHUNK_BYTES);
    const bytes = Array.from(chunk, (byte) => byte.toString(16).padStart(2, '0')).join(' ');
    yield `send-keys -H -t ${paneId} ${bytes}`;
  }
}

export function terminalColorControlCommand(paneId: string, slot: TerminalColorSlot, color: string): string {
  if (!/^%\d+$/.test(paneId)) throw new Error('Terminal pane identifier is invalid.');
  // Control mode clients report terminal replies through refresh-client, not pane keyboard input.
  return `refresh-client -r '${paneId}:${terminalColorReport(slot, color)}'`;
}

export function tmuxSupportsTerminalColorReports(commandList: string): boolean {
  return commandList.split(/\r?\n/).some((line) => /^refresh-client(?:\s|\()/.test(line) && /\[-r(?:\s|\])/.test(line));
}

export function terminalActivityTimestamp(output: string): number | undefined {
  const value = output.trim();
  if (!/^\d+$/.test(value)) return undefined;
  const milliseconds = Number(value) * 1_000;
  return Number.isSafeInteger(milliseconds) && milliseconds > 0 ? milliseconds : undefined;
}

interface OutputActivityState {
  snapshotAcknowledged: boolean;
  syntheticOutputDepth: number;
  syntheticOutputUntil: number;
  sharedOutputAllowed?: boolean;
}

interface QueuedOutput {
  data: string;
  activity: boolean;
  activityAt: number | null;
}

interface QueuedScreenSynchronization extends QueuedOutput {
  history?: TerminalHistoryState;
  reset?: boolean;
}

async function terminalTarget(
  tmuxSession: string,
  requestedWindowId?: string
): Promise<{ windowId: string; paneId: string; geometry: TerminalSize }> {
  if (requestedWindowId !== undefined && !/^@\d+$/.test(requestedWindowId)) {
    throw new Error('Terminal identifier is invalid.');
  }
  const target = requestedWindowId ?? tmuxSession;
  const { stdout } = await execFile(
    'tmux',
    tmuxCommandArguments([
      'display-message',
      '-p',
      '-t',
      target,
      '#{session_name}\t#{window_id}\t#{pane_id}\t#{pane_width}\t#{pane_height}',
    ])
  );
  const [sessionName, windowId, paneId, rawColumns, rawRows] = stdout.trim().split('\t');
  const columns = Number(rawColumns);
  const rows = Number(rawRows);
  if (sessionName !== tmuxSession || !/^@\d+$/.test(windowId ?? '') || !/^%\d+$/.test(paneId ?? '')) {
    throw new Error('Terminal does not belong to this workspace.');
  }
  if (requestedWindowId !== undefined && windowId !== requestedWindowId) {
    throw new Error('Terminal does not belong to this workspace.');
  }
  if (
    !Number.isInteger(columns) ||
    columns < TERMINAL_GEOMETRY_LIMITS.minimumColumns ||
    columns > TERMINAL_GEOMETRY_LIMITS.maximumColumns ||
    !Number.isInteger(rows) ||
    rows < TERMINAL_GEOMETRY_LIMITS.minimumRows ||
    rows > TERMINAL_GEOMETRY_LIMITS.maximumRows
  )
    throw new Error('Terminal geometry is invalid.');
  return { windowId, paneId, geometry: { columns, rows } };
}

export function isTerminalOutputActivity(
  { snapshotAcknowledged, syntheticOutputDepth, syntheticOutputUntil, sharedOutputAllowed = true }: OutputActivityState,
  timestamp: number
): boolean {
  return snapshotAcknowledged && syntheticOutputDepth === 0 && timestamp >= syntheticOutputUntil && sharedOutputAllowed;
}

export function terminalScreenMessageExceedsBackpressure(bufferedBytes: number, messageBytes: number): boolean {
  return (
    bufferedBytes > MAX_TERMINAL_SOCKET_BACKLOG_BYTES ||
    messageBytes > MAX_TERMINAL_SCREEN_FRAME_BYTES ||
    bufferedBytes + messageBytes > MAX_TERMINAL_SCREEN_FRAME_BYTES
  );
}

export function terminalEncodedScreenDataBytes(data: string): number {
  // Terminal data is nested in JSON, where control sequences and newlines can
  // expand several-fold. Measure the encoded string, not the raw PTY bytes.
  return Math.max(0, Buffer.byteLength(JSON.stringify(data)) - 2);
}

function closeBackpressuredTerminalSocket(socket: WebSocket): void {
  if (terminalBackpressureTimers.has(socket)) return;
  socket.close(1013, 'terminal output fell behind');
  const timer = setTimeout(() => {
    terminalBackpressureTimers.delete(socket);
    if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
  }, TERMINAL_BACKPRESSURE_TERMINATE_MS);
  timer.unref();
  terminalBackpressureTimers.set(socket, timer);
  socket.once('close', () => {
    const pending = terminalBackpressureTimers.get(socket);
    if (pending) clearTimeout(pending);
    terminalBackpressureTimers.delete(socket);
  });
}

export function sendTerminalMessage(socket: WebSocket, payload: TerminalServerMessage): boolean {
  if (socket.readyState !== WebSocket.OPEN) return false;
  const encoded = encodeTerminalServerMessage(payload);
  if (
    (payload.type === 'snapshot' || payload.type === 'output') &&
    terminalScreenMessageExceedsBackpressure(socket.bufferedAmount, Buffer.byteLength(encoded))
  ) {
    closeBackpressuredTerminalSocket(socket);
    return false;
  }
  socket.send(encoded);
  return true;
}

export async function attachTerminal(
  socket: WebSocket,
  tmuxSession: string,
  initialSize: TerminalSize | undefined,
  options: AttachTerminalOptions = {}
): Promise<void> {
  if (options.isAuthorized?.() === false) throw new Error('Terminal authorization is no longer active.');
  const snapshotHistoryLines = terminalSnapshotHistoryLines(options.historyLines);

  const { windowId, paneId, geometry: targetGeometry } = await terminalTarget(tmuxSession, options.terminalId);
  if (options.isAuthorized?.() === false) throw new Error('Terminal authorization is no longer active.');
  options.onGeometryChange?.(targetGeometry);
  const controlLease = retainTerminalControlHub(tmuxSession, windowId, paneId, targetGeometry);
  const controlHub = controlLease.hub;
  const sizeOwner = {};
  let closed = false;
  const inputAllowed = () => !closed && options.isAuthorized?.() !== false;
  let snapshotId = 0;
  let pendingSnapshotId: number | undefined;
  const terminalDelivery = new TerminalDeliveryBuffer<QueuedOutput, QueuedScreenSynchronization>(
    MAX_SNAPSHOT_OUTPUT_QUEUE_BYTES
  );
  const submissionLedger = new TerminalSubmissionLedger();
  const attached = controlHub.ready;
  let inputQueue: Promise<void> = Promise.resolve();
  let pendingInputBytes = 0;
  let preferredSize: TerminalSize | undefined = initialSize;
  let lastControlledSize: TerminalSize | undefined;
  let requestedSize: TerminalSize | undefined = initialSize;
  let appliedSize: string | undefined;
  let currentGeometry = targetGeometry;
  let resizing = false;
  let messageWindowStartedAt = Date.now();
  let messageCount = 0;
  let syntheticOutputDepth = 0;
  let syntheticOutputUntil = 0;
  let lastOutputActivityNotice = 0;
  let sizeIgnored = Boolean(options.ignoreSize);
  let terminalControlSequenceTail = '';
  let alternateScreenExitResyncPending = false;
  let alternateScreenExitResyncRequested = false;
  let historyCapturePending = false;
  let loadedHistoryLines = options.lazyHistory ? 0 : snapshotHistoryLines;
  let suppressedOutputResyncRequested = false;
  let suppressedOutputResyncRunning = false;
  let suppressedOutputResyncTimer: ReturnType<typeof setTimeout> | undefined;
  let suppressedOutputResyncInputVersion: number | undefined;
  let screenSynchronizationGeneration = 0;
  let explicitActivationPending = false;

  const runControlCommand = (command: string, onSuccess?: (output: string) => void): Promise<string> =>
    controlHub.runCommand(command, onSuccess);
  const scheduleTerminalOperation = <T>(operation: () => Promise<T>): Promise<T> =>
    controlHub.runOperation(() => (options.scheduleOperation ? options.scheduleOperation(operation) : operation()));
  let terminalColorReportSupport: Promise<boolean> | undefined;
  const supportsTerminalColorReports = (): Promise<boolean> => {
    terminalColorReportSupport ??= runControlCommand('list-commands')
      .then(tmuxSupportsTerminalColorReports)
      .catch(() => false);
    return terminalColorReportSupport;
  };
  const captureTerminalSnapshot = async (
    requestedHistoryLines: number,
    geometry: TerminalSize,
    restoreCanonical = false
  ): Promise<{ data: string; history: TerminalHistoryState }> => {
    // A tmux control notification never occurs inside a command response block.
    // Require one unchanged output version across the state and all captures,
    // then enqueue the canonical restore synchronously from the final %end
    // callback. Any later pane output is consequently parsed after that restore.
    for (let attempt = 0; attempt < 20 && (!closed || restoreCanonical); attempt += 1) {
      const outputVersion = controlHub.outputVersion;
      let rawState = '';
      let rawHistorySize = '';
      await Promise.all([
        runControlCommand(`display-message -p -t ${paneId} '${TERMINAL_PANE_STATE_FORMAT}'`, (output) => {
          rawState = output;
        }),
        runControlCommand(`display-message -p -t ${paneId} '#{history_size}'`, (output) => {
          rawHistorySize = output;
        }),
      ]);
      if (controlHub.outputVersion !== outputVersion) continue;

      const state = terminalPaneState(rawState, geometry);
      const availableHistory = terminalAvailableHistoryLines(rawHistorySize, TERMINAL_SCROLLBACK_LINES.standard);
      const loadedHistory = state?.alternateScreen
        ? 0
        : Math.min(availableHistory, Math.max(0, Math.min(TERMINAL_SCROLLBACK_LINES.standard, requestedHistoryLines)));
      const captureFlag = terminalCaptureFlag(state);
      const historyFlag = captureFlag === '-J' && loadedHistory > 0 ? ` -S -${loadedHistory}` : '';
      let snapshot = '';
      let savedMainSnapshot = '';
      let physicalSnapshot = '';
      let captured: { data: string; history: TerminalHistoryState } | undefined;
      let canonicalRestore: ReturnType<typeof controlHub.restoreCanonical> | undefined;
      await Promise.all([
        runControlCommand(`capture-pane -p -e ${captureFlag}${historyFlag} -t ${paneId}`, (output) => {
          snapshot = output;
        }),
        runControlCommand(`capture-pane -p -e -J -a -q -t ${paneId}`, (output) => {
          savedMainSnapshot = output;
        }),
        runControlCommand(`capture-pane -p -e -N -t ${paneId}`, (output) => {
          physicalSnapshot = output;
          if (controlHub.outputVersion !== outputVersion) return;
          const snapshotData = captureFlag === '-N' ? terminalPhysicalCaptureData(snapshot) : snapshot;
          captured = {
            data: terminalSnapshotData(snapshotData, state, savedMainSnapshot, physicalSnapshot),
            history: { loaded: loadedHistory, available: availableHistory },
          };
          if (restoreCanonical)
            canonicalRestore = controlHub.restoreCanonical(
              captured.data,
              geometry,
              captured.history.loaded,
              captured.history.available
            );
        }),
      ]);
      if (!captured) continue;
      if (canonicalRestore) await canonicalRestore;
      return captured;
    }
    throw new Error('Terminal output did not settle while establishing an authoritative snapshot.');
  };

  const canonicalTerminalSnapshot = async (
    requestedHistoryLines: number,
    geometry: TerminalSize
  ): Promise<{ data: string; history: TerminalHistoryState; throughSequence: number }> => {
    await controlHub.ensureCanonical(async () => {
      const captured = await captureTerminalSnapshot(requestedHistoryLines, geometry, true);
      return {
        availableHistory: captured.history.available,
        loadedHistory: captured.history.loaded,
      };
    });
    if (requestedHistoryLines > controlHub.loadedHistory) {
      await controlHub.extendCanonicalHistory(requestedHistoryLines, async () => {
        const captured = await captureTerminalSnapshot(requestedHistoryLines, geometry, true);
        return {
          availableHistory: captured.history.available,
          loadedHistory: captured.history.loaded,
        };
      });
    }
    const snapshot = await controlHub.snapshot(requestedHistoryLines);
    const available = Math.min(TERMINAL_SCROLLBACK_LINES.standard, snapshot.availableHistory);
    const loaded = snapshot.alternateScreen
      ? 0
      : Math.min(available, Math.max(0, Math.min(TERMINAL_SCROLLBACK_LINES.standard, requestedHistoryLines)));
    return {
      data: snapshot.data,
      history: { loaded, available },
      throughSequence: snapshot.throughSequence,
    };
  };

  const closeForOversizedScreen = (): void => {
    sendTerminalMessage(socket, {
      type: 'error',
      message: 'This terminal screen is too large to display safely. Reduce the pane size and reconnect.',
    });
    socket.close(1009, 'terminal screen exceeds limit');
  };

  const boundedCanonicalTerminalSnapshot = async (
    requestedHistoryLines: number,
    geometry: TerminalSize
  ): ReturnType<typeof canonicalTerminalSnapshot> => {
    let snapshot = await canonicalTerminalSnapshot(requestedHistoryLines, geometry);
    while (
      terminalEncodedScreenDataBytes(snapshot.data) > MAX_TERMINAL_ENCODED_SCREEN_DATA_BYTES &&
      snapshot.history.loaded > 0
    ) {
      const reducedHistory = Math.floor(snapshot.history.loaded / 2);
      snapshot = await canonicalTerminalSnapshot(reducedHistory, geometry);
    }
    if (terminalEncodedScreenDataBytes(snapshot.data) > MAX_TERMINAL_ENCODED_SCREEN_DATA_BYTES) {
      closeForOversizedScreen();
      throw new TerminalScreenFrameTooLargeError();
    }
    return snapshot;
  };

  const sendControlInput = async (data: string): Promise<void> => {
    for (const command of terminalInputControlCommands(paneId, data)) {
      if (!inputAllowed()) return;
      await runControlCommand(command);
    }
  };

  const sendTerminalSubmission = (data: string, bracketedPaste: boolean): Promise<boolean> =>
    executeTerminalSubmission(data, bracketedPaste, {
      inputAllowed,
      sendInput: sendControlInput,
      sendEnter: async () => {
        await runControlCommand(`send-keys -t ${paneId} Enter`);
      },
    });

  const queueTerminalInput = (
    data: string,
    operation: () => Promise<unknown>,
    scheduleGlobally = true,
    callbacks: { onCompleted?: () => void; onFailed?: (error: unknown) => void } = {}
  ): void => {
    if (!inputAllowed()) return;
    const reportFailure = (error: unknown): void => {
      if (callbacks.onFailed) {
        callbacks.onFailed(error);
        return;
      }
      sendTerminalMessage(socket, {
        type: 'error',
        message: error instanceof Error ? error.message : 'Terminal input failed.',
      });
    };
    const bytes = Buffer.byteLength(data);
    if (bytes > TERMINAL_INPUT_LIMIT_BYTES) {
      reportFailure(new Error('Input is too large.'));
      return;
    }
    if (pendingInputBytes + bytes > MAX_PENDING_INPUT_BYTES) {
      reportFailure(new Error('Terminal input was paused because the server fell behind.'));
      socket.close(1013, 'terminal input fell behind');
      return;
    }
    pendingInputBytes += bytes;
    if (syntheticOutputDepth === 0) syntheticOutputUntil = 0;
    inputQueue = inputQueue
      .then(async () => {
        if (!inputAllowed()) return;
        const completed = scheduleGlobally ? await scheduleTerminalOperation(operation) : await operation();
        if (completed !== false && inputAllowed()) callbacks.onCompleted?.();
      })
      .catch(reportFailure)
      .finally(() => {
        pendingInputBytes -= bytes;
      });
  };

  const waitForTerminalRedraw = async (
    graceMs = TERMINAL_REDRAW_GRACE_MS,
    settleLimitMs = TERMINAL_REDRAW_SETTLE_LIMIT_MS
  ): Promise<void> => {
    const startedAt = Date.now();
    const deadline = Date.now() + settleLimitMs;
    let observedVersion = controlHub.outputVersion;
    let quietSince = Date.now();
    while (!closed && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, TERMINAL_REDRAW_POLL_MS));
      if (controlHub.outputVersion !== observedVersion) {
        observedVersion = controlHub.outputVersion;
        quietSince = Date.now();
        continue;
      }
      if (Date.now() - startedAt >= graceMs && Date.now() - quietSince >= TERMINAL_REDRAW_QUIET_MS) return;
    }
  };

  const waitForInitialTerminalContent = async (): Promise<void> => {
    const outputVersion = controlHub.outputVersion;
    const visiblePane = await runControlCommand(`capture-pane -p -t ${paneId}`);
    if (visiblePane.trim() || controlHub.outputVersion !== outputVersion) {
      await waitForTerminalRedraw();
      return;
    }

    const deadline = Date.now() + TERMINAL_INITIAL_OUTPUT_WAIT_MS;
    while (!closed && controlHub.outputVersion === outputVersion && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, TERMINAL_REDRAW_POLL_MS));
    }
    if (!closed && controlHub.outputVersion !== outputVersion) await waitForTerminalRedraw();
  };

  const waitForTerminalGeometry = async (geometry: TerminalSize): Promise<void> => {
    const expected = `${geometry.columns}x${geometry.rows}`;
    for (let attempt = 0; attempt < 100 && !closed; attempt += 1) {
      const actual = await runControlCommand(`display-message -p -t ${paneId} '#{pane_width}x#{pane_height}'`);
      if (actual.trim() === expected) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Terminal geometry did not settle before screen synchronization.');
  };

  const withSyntheticOutput = async <T>(
    operation: () => Promise<T>,
    settleMs = SYNTHETIC_OUTPUT_SETTLE_MS,
    afterRedraw?: (result: T) => Promise<void> | void
  ): Promise<T> => {
    syntheticOutputDepth += 1;
    if (syntheticOutputDepth === 1) options.onSyntheticOutputGateChange?.(true);
    options.onSyntheticOutput?.(Date.now() + settleMs);
    try {
      const result = await operation();
      // tmux may finish the resize command before its control-mode redraw
      // notifications arrive. Capturing immediately can therefore restore the
      // previous device's grid after the pane already has its new geometry.
      await waitForTerminalRedraw();
      if (afterRedraw) {
        const deadline = Date.now() + TERMINAL_REDRAW_SETTLE_LIMIT_MS;
        while (!closed) {
          const outputVersion = controlHub.outputVersion;
          await afterRedraw(result);
          const remainingMs = deadline - Date.now();
          if (remainingMs <= 0) break;
          await waitForTerminalRedraw(Math.min(TERMINAL_POST_SYNCHRONIZATION_GRACE_MS, remainingMs), remainingMs);
          if (controlHub.outputVersion === outputVersion) break;
        }
      }
      return result;
    } finally {
      try {
        const activity = terminalActivityTimestamp(
          await runControlCommand(`display-message -p -t ${windowId} '#{window_activity}'`)
        );
        if (activity !== undefined) options.onSyntheticActivity?.(activity);
      } catch {
        // Activity classification must not turn a successful terminal resize into an error.
      }
      syntheticOutputUntil = Math.max(syntheticOutputUntil, Date.now() + settleMs);
      options.onSyntheticOutput?.(syntheticOutputUntil);
      syntheticOutputDepth -= 1;
      if (syntheticOutputDepth === 0) options.onSyntheticOutputGateChange?.(false);
    }
  };

  const reconcileCanonicalAfterResize = async (geometry: TerminalSize): Promise<void> => {
    // xterm and tmux do not always reflow a saved main screen identically when
    // an alternate screen has crossed narrow and wide geometries. Once tmux's
    // redraw is quiet, restore the canonical actor from the pane's exact state
    // before any subscriber receives the committed geometry. Capture only the
    // history already loaded by a subscriber; the default mobile resize remains
    // a visible-screen operation instead of reparsing the full 10,000 lines.
    await waitForTerminalGeometry(geometry);
    await captureTerminalSnapshot(controlHub.loadedHistory, geometry, true);
  };

  const sendDeliveryBatch = (batch: TerminalDeliveryBatch<QueuedOutput, QueuedScreenSynchronization>): void => {
    if (batch.synchronization) {
      sendTerminalMessage(socket, {
        type: 'output',
        ...batch.synchronization.value,
        screenSync: true,
        ...(options.outputSequences ? { throughSequence: batch.synchronization.throughSequence } : {}),
      });
    }
    for (const output of batch.outputs) {
      sendTerminalMessage(socket, {
        type: 'output',
        ...output.value,
        ...(options.outputSequences ? { sequence: output.sequence } : {}),
      });
    }
  };

  const sendTerminalGeometry = (geometry: TerminalSize): void => {
    if (!options.sendGeometry) return;
    sendTerminalMessage(socket, {
      type: 'geometry',
      ...geometry,
      ...(options.hasControl ? { active: options.hasControl() } : {}),
    });
  };

  const sendTerminalOutput = (output: string, sequence: number): void => {
    const alternateScreenExit = terminalAlternateScreenExitState(terminalControlSequenceTail, output);
    terminalControlSequenceTail = alternateScreenExit.tail;
    const now = Date.now();
    if (terminalDelivery.acknowledged && (syntheticOutputDepth > 0 || options.isOutputSuppressed?.() === true)) {
      if (alternateScreenExit.exited) scheduleAlternateScreenExitResync();
      else scheduleSuppressedOutputResync();
      return;
    }
    const locallyEligible = terminalDelivery.acknowledged && syntheticOutputDepth === 0 && now >= syntheticOutputUntil;
    const activity = isTerminalOutputActivity(
      {
        snapshotAcknowledged: terminalDelivery.acknowledged,
        syntheticOutputDepth,
        syntheticOutputUntil,
        sharedOutputAllowed: !locallyEligible || options.isOutputActivity?.(now) !== false,
      },
      now
    );
    const activityAt = activity ? now : null;
    if (activity && now - lastOutputActivityNotice >= 250) {
      lastOutputActivityNotice = now;
      options.onOutputActivity?.(now);
    }
    const queued = terminalDelivery.enqueueOutput({
      sequence,
      bytes: Buffer.byteLength(output),
      value: {
        data: output,
        activity,
        activityAt,
      },
    });
    if (queued.overflowed) {
      sendTerminalMessage(socket, { type: 'error', message: 'Terminal output arrived before the screen was ready.' });
      socket.close(1013, 'terminal snapshot fell behind');
      return;
    }
    sendDeliveryBatch(queued);
    if (alternateScreenExit.exited) scheduleAlternateScreenExitResync();
  };

  const acknowledgeSnapshot = (acknowledgedSnapshotId?: number): void => {
    if (!terminalDelivery.snapshotSent || terminalDelivery.acknowledged || closed) return;
    if (options.snapshotIds && acknowledgedSnapshotId !== pendingSnapshotId) return;
    sendDeliveryBatch(terminalDelivery.acknowledge());
    if (alternateScreenExitResyncRequested) scheduleAlternateScreenExitResync();
    if (suppressedOutputResyncRequested) armSuppressedOutputResync();
  };

  const loadTerminalHistory = async (lines: number): Promise<void> => {
    if (closed) return;
    terminalDelivery.beginSnapshot();
    try {
      const geometry = options.getGeometry?.() ?? currentGeometry;
      const snapshot = await boundedCanonicalTerminalSnapshot(lines, geometry);
      if (closed) return;
      loadedHistoryLines = snapshot.history.loaded;
      terminalDelivery.publishSnapshot(snapshot.throughSequence);
      pendingSnapshotId = options.snapshotIds ? ++snapshotId : undefined;
      sendTerminalMessage(socket, {
        type: 'snapshot',
        data: snapshot.data,
        history: snapshot.history,
        ...(pendingSnapshotId === undefined ? {} : { snapshotId: pendingSnapshotId }),
        ...(options.outputSequences ? { throughSequence: snapshot.throughSequence } : {}),
      });
      sendTerminalMessage(socket, { type: 'screen-ready' });
    } catch (error) {
      if (!closed) {
        if (error instanceof TerminalScreenFrameTooLargeError) closeForOversizedScreen();
        else socket.close(1013, 'terminal history synchronization failed');
      }
      throw error;
    }
  };

  const clearSuppressedOutputResync = (): void => {
    suppressedOutputResyncRequested = false;
    suppressedOutputResyncInputVersion = undefined;
    if (suppressedOutputResyncTimer) clearTimeout(suppressedOutputResyncTimer);
    suppressedOutputResyncTimer = undefined;
  };

  async function resyncTerminalScreen(geometry?: TerminalSize, expectedInputVersion?: number): Promise<void> {
    if (!terminalDelivery.snapshotSent || closed) return;
    const sharedGeometry = options.getGeometry?.();
    if (
      geometry &&
      sharedGeometry &&
      (geometry.columns !== sharedGeometry.columns || geometry.rows !== sharedGeometry.rows)
    )
      return;
    const synchronizationGeneration = ++screenSynchronizationGeneration;
    const geometryRevision = options.getGeometryRevision?.();
    const synchronizationIsCurrent = () =>
      !closed &&
      synchronizationGeneration === screenSynchronizationGeneration &&
      (geometryRevision === undefined || options.getGeometryRevision?.() === geometryRevision);
    if (geometry) {
      await waitForTerminalGeometry(geometry);
      if (!synchronizationIsCurrent()) return;
    } else {
      await runControlCommand(SYNTHETIC_OUTPUT_BARRIER);
    }
    if (!synchronizationIsCurrent()) return;
    const synchronizedGeometry = geometry ?? sharedGeometry ?? currentGeometry;
    const deliverySynchronizationGeneration = options.resetScreenSync
      ? terminalDelivery.beginSynchronization()
      : undefined;
    const captureSynchronizedScreen = async (): Promise<{
      data: string;
      history?: TerminalHistoryState;
      throughSequence?: number;
    }> => {
      if (options.resetScreenSync) {
        if (!geometry) {
          // tmux restores its saved main screen with semantics that are not
          // equivalent to feeding ?1049l into a separately resized xterm.
          // Let the shell redraw finish, then reconcile the shared actor before
          // fencing the alternate-screen exit for this subscriber.
          await waitForTerminalRedraw();
          await captureTerminalSnapshot(controlHub.loadedHistory, synchronizedGeometry, true);
        }
        // The headless xterm model has already applied every pane byte and the
        // same ordered resize. Serialize that actor directly: recapturing up to
        // 10,000 tmux rows on every soft-keyboard frame is both slower and less
        // race-safe than reading the canonical sequence fence.
        const snapshot = await boundedCanonicalTerminalSnapshot(loadedHistoryLines, synchronizedGeometry);
        return {
          data: snapshot.data,
          history: snapshot.history,
          throughSequence: snapshot.throughSequence,
        };
      }
      // Protocol v2 clients understand visible-grid replacement but not an
      // authoritative buffer reset. Keep the legacy payload until they reload.
      const [snapshot, rawState, savedMainSnapshot, physicalSnapshot] = await Promise.all([
        runControlCommand(`capture-pane -p -e -J -t ${paneId}`),
        runControlCommand(`display-message -p -t ${paneId} '${TERMINAL_PANE_STATE_FORMAT}'`),
        runControlCommand(`capture-pane -p -e -J -a -q -t ${paneId}`),
        runControlCommand(`capture-pane -p -e -N -t ${paneId}`),
      ]);
      const state = terminalPaneState(rawState, synchronizedGeometry);
      const snapshotData = state?.alternateScreen ? terminalPhysicalCaptureData(physicalSnapshot) : snapshot;
      return { data: terminalScreenData(snapshotData, state, savedMainSnapshot, physicalSnapshot) };
    };
    let synchronizedScreen: Awaited<ReturnType<typeof captureSynchronizedScreen>> | undefined;
    if (options.resetScreenSync) {
      synchronizedScreen = await captureSynchronizedScreen();
    } else {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const outputVersion = controlHub.outputVersion;
        const candidate = await captureSynchronizedScreen();
        if (!synchronizationIsCurrent()) return;
        if (controlHub.outputVersion === outputVersion) {
          synchronizedScreen = candidate;
          break;
        }
      }
    }
    if (!synchronizedScreen) throw new Error('Terminal output did not settle during screen synchronization.');
    if (!synchronizationIsCurrent()) {
      if (deliverySynchronizationGeneration !== undefined)
        sendDeliveryBatch(terminalDelivery.abandonSynchronization(deliverySynchronizationGeneration));
      return;
    }
    if (expectedInputVersion !== undefined && options.getInputVersion?.() !== expectedInputVersion) {
      if (deliverySynchronizationGeneration !== undefined)
        sendDeliveryBatch(terminalDelivery.abandonSynchronization(deliverySynchronizationGeneration));
      scheduleSuppressedOutputResync();
      return;
    }
    const synchronization: QueuedScreenSynchronization = {
      data: synchronizedScreen.data,
      activity: false,
      activityAt: null,
      ...(options.resetScreenSync ? { reset: true, history: synchronizedScreen.history } : {}),
    };
    if (deliverySynchronizationGeneration !== undefined && synchronizedScreen.throughSequence !== undefined) {
      sendDeliveryBatch(
        terminalDelivery.completeSynchronization(deliverySynchronizationGeneration, {
          throughSequence: synchronizedScreen.throughSequence,
          value: synchronization,
        })
      );
    } else {
      sendTerminalMessage(socket, { type: 'output', ...synchronization, screenSync: true });
    }
    clearSuppressedOutputResync();
  }

  function scheduleAlternateScreenExitResync(): void {
    if (closed) return;
    alternateScreenExitResyncRequested = true;
    if (!terminalDelivery.snapshotSent) return;
    if (!terminalDelivery.acknowledged || alternateScreenExitResyncPending) return;
    alternateScreenExitResyncPending = true;
    setTimeout(() => {
      void (async () => {
        while (alternateScreenExitResyncRequested && !closed) {
          alternateScreenExitResyncRequested = false;
          await scheduleTerminalOperation(() => resyncTerminalScreen());
        }
      })()
        .catch(() => {
          if (!closed) socket.close(1013, 'terminal screen synchronization failed');
        })
        .finally(() => {
          alternateScreenExitResyncPending = false;
          if (alternateScreenExitResyncRequested) scheduleAlternateScreenExitResync();
        });
    }, 0);
  }

  function scheduleSuppressedOutputResync(): void {
    if (!terminalDelivery.snapshotSent || closed) return;
    suppressedOutputResyncRequested = true;
    suppressedOutputResyncInputVersion = options.getInputVersion?.();
    armSuppressedOutputResync();
  }

  function armSuppressedOutputResync(): void {
    if (!terminalDelivery.acknowledged || suppressedOutputResyncRunning) return;
    if (suppressedOutputResyncTimer) clearTimeout(suppressedOutputResyncTimer);
    suppressedOutputResyncTimer = setTimeout(() => {
      suppressedOutputResyncTimer = undefined;
      if (closed || !terminalDelivery.acknowledged) return;
      const inputVersion = suppressedOutputResyncInputVersion;
      if (inputVersion !== undefined && options.getInputVersion?.() !== inputVersion) {
        suppressedOutputResyncRequested = false;
        return;
      }
      if (syntheticOutputDepth > 0 || options.isOutputSuppressed?.() === true) {
        armSuppressedOutputResync();
        return;
      }
      suppressedOutputResyncRequested = false;
      suppressedOutputResyncRunning = true;
      void resyncTerminalScreen(options.getGeometry?.() ?? currentGeometry, inputVersion)
        .catch(() => {
          if (!closed) socket.close(1013, 'terminal screen synchronization failed');
        })
        .finally(() => {
          suppressedOutputResyncRunning = false;
          if (suppressedOutputResyncRequested) armSuppressedOutputResync();
        });
    }, TERMINAL_REDRAW_QUIET_MS);
  }

  const unsubscribeControlHub = controlHub.subscribe({
    onOutput: (output) => sendTerminalOutput(output.data, output.sequence),
    onUnavailable: () => {
      if (closed) return;
      sendTerminalMessage(socket, { type: 'error', message: 'The tmux session is no longer available.' });
      socket.close(1011, 'tmux session unavailable');
    },
  });
  const closeTerminalControl = () => {
    if (closed) return;
    const releasedSize = controlHub.releaseSize(sizeOwner);
    closed = true;
    if (suppressedOutputResyncTimer) clearTimeout(suppressedOutputResyncTimer);
    suppressedOutputResyncTimer = undefined;
    suppressedOutputResyncRequested = false;
    suppressedOutputResyncInputVersion = undefined;
    options.onSyntheticOutput?.(Date.now() + SYNTHETIC_OUTPUT_SETTLE_MS);
    terminalDelivery.clear();
    unsubscribeControlHub();
    if (releasedSize && !controlHub.closed)
      void controlHub.runCommand('refresh-client -f ignore-size').catch(() => undefined);
    controlLease.release();
  };
  const unsubscribeAuthorization = options.onAuthorizationRevoked?.(closeTerminalControl) ?? (() => undefined);
  socket.once('close', () => {
    closeTerminalControl();
    unsubscribeAuthorization();
  });

  const resizeControlClient = async (): Promise<void> => {
    if (resizing || closed) return;
    if (sizeIgnored || !controlHub.ownsSize(sizeOwner) || options.canResize?.() === false) {
      sendTerminalGeometry(options.getGeometry?.() ?? currentGeometry);
      return;
    }
    resizing = true;
    try {
      while (requestedSize && !closed && options.canResize?.() !== false) {
        const next = requestedSize;
        requestedSize = undefined;
        if (lastControlledSize && terminalGeometryIsColumnJitter(lastControlledSize, next)) {
          preferredSize = lastControlledSize;
          sendTerminalGeometry(lastControlledSize);
          continue;
        }
        const key = `${next.columns}x${next.rows}`;
        if (key === appliedSize) continue;
        const previousGeometry = currentGeometry;
        try {
          await withSyntheticOutput(
            async () => {
              // Fence all output parsed at the old geometry before announcing
              // the new grid. The shared gate is already active while the actor
              // drains, so no old-grid ANSI can reach a resized browser.
              await controlHub.resizeCanonical(next);
              currentGeometry = next;
              options.onGeometryChange?.(next);
              await runControlCommand(`refresh-client -C ${key}`);
              await runControlCommand(SYNTHETIC_OUTPUT_BARRIER);
            },
            TERMINAL_RESIZE_ACTIVITY_SUPPRESSION_MS,
            async () => {
              await reconcileCanonicalAfterResize(next);
              await options.onResizeComplete?.(next);
            }
          );
          appliedSize = key;
          lastControlledSize = next;
        } catch (error) {
          await withSyntheticOutput(async () => {
            await controlHub.resizeCanonical(previousGeometry);
            currentGeometry = previousGeometry;
            options.onGeometryChange?.(previousGeometry);
          }).catch(() => undefined);
          throw error;
        }
      }
    } catch (error) {
      sendTerminalMessage(socket, {
        type: 'error',
        message: error instanceof Error ? error.message : 'Terminal resize failed.',
      });
    } finally {
      resizing = false;
      if (requestedSize && !closed) void resizeControlClient();
    }
  };

  const setIgnoreSizeDirect = async (ignored: boolean): Promise<void> => {
    if (closed) return;
    if (!ignored && sizeIgnored) {
      const firstSizeOwner = controlHub.claimSize(sizeOwner);
      // Geometry broadcasts resize every xterm to the shared pane, so a passive
      // browser may not send its unchanged fit again. Retain its last requested
      // device size and restore that preference when it takes control.
      requestedSize = explicitActivationPending
        ? (preferredSize ?? requestedSize)
        : (lastControlledSize ?? requestedSize);
      await withSyntheticOutput(
        async () => {
          while (requestedSize && !closed) {
            const requested = requestedSize;
            requestedSize = undefined;
            const next =
              lastControlledSize && terminalGeometryIsColumnJitter(lastControlledSize, requested)
                ? lastControlledSize
                : requested;
            const key = `${next.columns}x${next.rows}`;
            const previousGeometry = currentGeometry;
            try {
              // Promotion follows the same fence as an ordinary resize: drain
              // old-grid output under the gate, then publish the new geometry.
              await controlHub.resizeCanonical(next);
              currentGeometry = next;
              options.onGeometryChange?.(next);
              await runControlCommand(`refresh-client -C ${key}`);
              appliedSize = key;
              lastControlledSize = next;
            } catch (error) {
              await controlHub.resizeCanonical(previousGeometry).catch(() => undefined);
              currentGeometry = previousGeometry;
              options.onGeometryChange?.(previousGeometry);
              throw error;
            }
          }
          options.onGeometryChange?.(currentGeometry);
          if (firstSizeOwner) await runControlCommand('refresh-client -f !ignore-size');
          // While ignore-size is set, -C updates only this client. Repeat it after
          // promotion so the pane has reached the announced geometry before capture.
          await runControlCommand(`refresh-client -C ${currentGeometry.columns}x${currentGeometry.rows}`);
          await runControlCommand(SYNTHETIC_OUTPUT_BARRIER);
        },
        TERMINAL_RESIZE_ACTIVITY_SUPPRESSION_MS,
        async () => {
          await reconcileCanonicalAfterResize(currentGeometry);
          await options.onResizeComplete?.(currentGeometry);
        }
      );
      lastControlledSize = currentGeometry;
      sizeIgnored = false;
    } else if (ignored && !sizeIgnored) {
      if (controlHub.releaseSize(sizeOwner))
        await withSyntheticOutput(() => runControlCommand('refresh-client -f ignore-size'));
      sizeIgnored = true;
    }
    if (!ignored) await resizeControlClient();
  };

  const setIgnoreSize = (ignored: boolean): Promise<void> =>
    scheduleTerminalOperation(() => setIgnoreSizeDirect(ignored));

  const settleTerminalSubmission = (result: TerminalSubmissionResult): void => {
    if (submissionLedger.settle(result)) sendTerminalMessage(socket, result);
  };

  socket.on('message', (raw, isBinary) => {
    if (isBinary || !inputAllowed()) return;
    const now = Date.now();
    if (now - messageWindowStartedAt >= MESSAGE_WINDOW_MS) {
      messageWindowStartedAt = now;
      messageCount = 0;
    }
    messageCount += 1;
    if (messageCount > MAX_MESSAGES_PER_WINDOW) {
      socket.close(1008, 'message rate exceeded');
      return;
    }

    try {
      const input = decodeTerminalClientMessage(raw);
      if (!input) throw new Error('Terminal input is invalid.');
      if (input.type === 'activate') {
        queueTerminalInput(
          '',
          async () => {
            explicitActivationPending = true;
            try {
              await options.onActivate?.();
            } finally {
              explicitActivationPending = false;
            }
          },
          false
        );
      } else if (input.type === 'snapshot-ready') {
        acknowledgeSnapshot(input.snapshotId);
      } else if (input.type === 'load-history') {
        if (options.lazyHistory && terminalDelivery.acknowledged && !historyCapturePending) {
          historyCapturePending = true;
          queueTerminalInput('', async () => {
            try {
              await loadTerminalHistory(input.lines);
            } finally {
              historyCapturePending = false;
            }
          });
        }
      } else if (input.type === 'input') {
        queueTerminalInput(input.data, async () => {
          options.onInput?.();
          await sendControlInput(input.data);
        });
      } else if (input.type === 'terminal-color') {
        queueTerminalInput(input.color, async () => {
          await attached;
          if (options.canReportTerminalColor?.() === false) return;
          if (!(await supportsTerminalColorReports())) return;
          if (options.canReportTerminalColor?.() === false) return;
          await runControlCommand(terminalColorControlCommand(paneId, input.slot, input.color));
        });
      } else if (input.type === 'submit') {
        const requestId = input.requestId;
        const runSubmission = async (): Promise<boolean> => {
          options.onInput?.();
          return sendTerminalSubmission(input.data, input.bracketedPaste);
        };
        if (!options.submissionResults || !requestId) {
          queueTerminalInput(input.data, runSubmission);
          return;
        }

        const registration = submissionLedger.register(requestId);
        if (registration.state === 'pending') return;
        if (registration.state === 'settled') {
          sendTerminalMessage(socket, registration.result);
          return;
        }
        if (registration.state === 'full') {
          sendTerminalMessage(socket, {
            type: 'submission-result',
            requestId,
            status: 'failed',
            message: 'Too many terminal submissions are awaiting confirmation.',
          });
          return;
        }

        queueTerminalInput(input.data, runSubmission, true, {
          onCompleted: () => {
            settleTerminalSubmission({
              type: 'submission-result',
              requestId,
              status: 'completed',
            });
          },
          onFailed: (error) => {
            settleTerminalSubmission({
              type: 'submission-result',
              requestId,
              status: 'failed',
              message: terminalSubmissionFailureMessage(error),
            });
          },
        });
      } else if (input.type === 'resize') {
        preferredSize = { columns: input.columns, rows: input.rows };
        requestedSize = preferredSize;
        queueTerminalInput('', resizeControlClient);
      }
    } catch (error) {
      sendTerminalMessage(socket, {
        type: 'error',
        message: error instanceof Error ? error.message : 'Terminal input failed.',
      });
    }
  });

  await attached;
  if (!inputAllowed()) return;
  await options.onAttached?.(setIgnoreSize, resyncTerminalScreen);
  if (!inputAllowed()) return;
  if (requestedSize) await scheduleTerminalOperation(resizeControlClient);
  await waitForInitialTerminalContent();
  if (!inputAllowed()) return;
  const initialSnapshot = await scheduleTerminalOperation(async () => {
    const geometry = options.getGeometry?.() ?? currentGeometry;
    const snapshot = await boundedCanonicalTerminalSnapshot(options.lazyHistory ? 0 : snapshotHistoryLines, geometry);
    return { geometry, snapshot };
  });
  const { geometry: snapshotGeometry, snapshot } = initialSnapshot;
  sendTerminalGeometry(snapshotGeometry);
  loadedHistoryLines = snapshot.history.loaded;
  terminalDelivery.publishSnapshot(snapshot.throughSequence);
  pendingSnapshotId = options.snapshotIds ? ++snapshotId : undefined;
  sendTerminalMessage(socket, {
    type: 'snapshot',
    data: snapshot.data,
    ...(options.lazyHistory ? { history: snapshot.history } : {}),
    ...(pendingSnapshotId === undefined ? {} : { snapshotId: pendingSnapshotId }),
    ...(options.outputSequences ? { throughSequence: snapshot.throughSequence } : {}),
  });
  sendTerminalMessage(socket, { type: 'screen-ready' });
  if (requestedSize) void resizeControlClient();
}
