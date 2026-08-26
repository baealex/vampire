import { execFile as execFileCallback, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import WebSocket from 'ws';

import {
  decodeTerminalClientMessage,
  encodeTerminalServerMessage,
  TERMINAL_GEOMETRY_LIMITS,
  TERMINAL_SCROLLBACK_LINES,
  type TerminalServerMessage,
} from '~/lib/shared/contracts/terminal-protocol.ts';
import { terminalColorReport, type TerminalColorSlot } from '~/lib/shared/contracts/terminal-color.ts';
import { terminalSubmissionData, terminalSubmissionSettleMs } from './submission.ts';
import { decodeTmuxControlValue, parseTmuxControlOutput } from './tmux-control.ts';

export { decodeTmuxControlValue, parseTmuxControlOutput } from './tmux-control.ts';
export { terminalSubmissionData, terminalSubmissionSettleMs };

const execFile = promisify(execFileCallback);
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_PENDING_INPUT_BYTES = 256 * 1024;
const TMUX_INPUT_CHUNK_BYTES = 4 * 1024;
const MAX_MESSAGES_PER_WINDOW = 600;
const MESSAGE_WINDOW_MS = 10_000;
const CONTROL_COMMAND_TIMEOUT_MS = 3_000;
const MAX_SNAPSHOT_OUTPUT_QUEUE_BYTES = 512 * 1024;
const SYNTHETIC_OUTPUT_SETTLE_MS = 150;
const TERMINAL_RESIZE_SETTLE_MS = 1_000;
const TERMINAL_REDRAW_QUIET_MS = 40;
const TERMINAL_REDRAW_GRACE_MS = 250;
const TERMINAL_REDRAW_SETTLE_LIMIT_MS = 1_000;
const TERMINAL_REDRAW_POLL_MS = 10;
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

export type TerminalSizeController = (ignored: boolean) => Promise<void>;
export type TerminalScreenSynchronizer = (geometry?: TerminalSize) => Promise<void>;

export interface AttachTerminalOptions {
  terminalId?: string;
  historyLines?: number;
  lazyHistory?: boolean;
  ignoreSize?: boolean;
  canResize?: () => boolean;
  canInput?: () => boolean | Promise<boolean>;
  canReportTerminalColor?: () => boolean;
  getGeometry?: () => TerminalSize | undefined;
  hasControl?: () => boolean;
  sendGeometry?: boolean;
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
  isOutputSuppressed?: () => boolean;
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

async function terminalTarget(
  tmuxSession: string,
  requestedWindowId?: string
): Promise<{ windowId: string; paneId: string; geometry: TerminalSize }> {
  if (requestedWindowId !== undefined && !/^@\d+$/.test(requestedWindowId)) {
    throw new Error('Terminal identifier is invalid.');
  }
  const target = requestedWindowId ?? tmuxSession;
  const { stdout } = await execFile('tmux', [
    'display-message',
    '-p',
    '-t',
    target,
    '#{session_name}\t#{window_id}\t#{pane_id}\t#{pane_width}\t#{pane_height}',
  ]);
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

function message(socket: WebSocket, payload: TerminalServerMessage): void {
  if (socket.readyState === 1) socket.send(encodeTerminalServerMessage(payload));
}

export async function attachTerminal(
  socket: WebSocket,
  tmuxSession: string,
  initialSize: TerminalSize | undefined,
  options: AttachTerminalOptions = {}
): Promise<void> {
  const snapshotHistoryLines = terminalSnapshotHistoryLines(options.historyLines);

  const { windowId, paneId, geometry: targetGeometry } = await terminalTarget(tmuxSession, options.terminalId);
  options.onGeometryChange?.(targetGeometry);
  const attachFlags = options.ignoreSize ? ['-f', 'ignore-size'] : [];
  const control = spawn('tmux', ['-C', 'attach-session', ...attachFlags, '-t', windowId], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  control.stderr.resume();
  let closed = false;
  let snapshotSent = false;
  let snapshotAcknowledged = false;
  let pendingSnapshotOutput: QueuedOutput[] = [];
  let pendingSnapshotOutputBytes = 0;
  let attachedResolve!: () => void;
  let attachedReject!: (reason: unknown) => void;
  const attached = new Promise<void>((resolve, reject) => {
    attachedResolve = resolve;
    attachedReject = reject;
  });
  const attachmentTimer = setTimeout(() => {
    attachedReject(new Error('tmux control client did not attach in time.'));
    control.kill();
  }, CONTROL_COMMAND_TIMEOUT_MS);
  void attached.then(
    () => clearTimeout(attachmentTimer),
    () => clearTimeout(attachmentTimer)
  );
  const pendingCommands: PendingControlCommand[] = [];
  let commandBlock: ControlCommandBlock | undefined;
  let inputQueue: Promise<void> = Promise.resolve();
  let pendingInputBytes = 0;
  let preferredSize: TerminalSize | undefined = initialSize;
  let requestedSize: TerminalSize | undefined = initialSize;
  let appliedSize: string | undefined;
  let currentGeometry = targetGeometry;
  let resizing = false;
  let messageWindowStartedAt = Date.now();
  let messageCount = 0;
  let syntheticOutputDepth = 0;
  let syntheticOutputUntil = 0;
  let lastOutputActivityNotice = 0;
  let controlLineBuffer = Buffer.alloc(0);
  const terminalDecoder = new TextDecoder();
  let sizeIgnored = Boolean(options.ignoreSize);
  let terminalControlSequenceTail = '';
  let terminalOutputVersion = 0;
  let alternateScreenExitResyncPending = false;
  let alternateScreenExitResyncRequested = false;
  let historyCapturePending = false;

  const rejectControlCommands = (error: unknown): void => {
    attachedReject(error);
    if (commandBlock?.command) {
      clearTimeout(commandBlock.command.timer);
      commandBlock.command.reject(error);
    }
    commandBlock = undefined;
    for (const command of pendingCommands.splice(0)) {
      clearTimeout(command.timer);
      command.reject(error);
    }
  };

  const runControlCommand = (command: string, onSuccess?: (output: string) => void): Promise<string> =>
    new Promise((resolve, reject) => {
      if (closed || control.exitCode !== null) {
        reject(new Error('tmux control client is unavailable.'));
        return;
      }
      const pending: PendingControlCommand = {
        resolve,
        reject,
        onSuccess,
        timer: setTimeout(() => {
          pending.reject(new Error('tmux control command timed out.'));
          control.kill();
        }, CONTROL_COMMAND_TIMEOUT_MS),
      };
      pendingCommands.push(pending);
      control.stdin.write(`${command}\n`, (error) => {
        if (!error) return;
        clearTimeout(pending.timer);
        const index = pendingCommands.indexOf(pending);
        if (index >= 0) pendingCommands.splice(index, 1);
        reject(error);
      });
    });
  let terminalColorReportSupport: Promise<boolean> | undefined;
  const supportsTerminalColorReports = (): Promise<boolean> => {
    terminalColorReportSupport ??= runControlCommand('list-commands')
      .then(tmuxSupportsTerminalColorReports)
      .catch(() => false);
    return terminalColorReportSupport;
  };
  const captureTerminalSnapshot = async (requestedHistoryLines: number, geometry: TerminalSize) => {
    const [rawState, rawHistorySize] = await Promise.all([
      runControlCommand(`display-message -p -t ${paneId} '${TERMINAL_PANE_STATE_FORMAT}'`),
      runControlCommand(`display-message -p -t ${paneId} '#{history_size}'`),
    ]);
    const state = terminalPaneState(rawState, geometry);
    const availableHistory = terminalAvailableHistoryLines(rawHistorySize, snapshotHistoryLines);
    const loadedHistory = state?.alternateScreen
      ? 0
      : Math.min(availableHistory, Math.max(0, Math.min(snapshotHistoryLines, requestedHistoryLines)));
    const captureFlag = terminalCaptureFlag(state);
    const historyFlag = captureFlag === '-J' && loadedHistory > 0 ? ` -S -${loadedHistory}` : '';
    const [snapshot, savedMainSnapshot, physicalSnapshot] = await Promise.all([
      runControlCommand(`capture-pane -p -e ${captureFlag}${historyFlag} -t ${paneId}`),
      runControlCommand(`capture-pane -p -e -J -a -q -t ${paneId}`),
      runControlCommand(`capture-pane -p -e -N -t ${paneId}`),
    ]);
    const snapshotData = captureFlag === '-N' ? terminalPhysicalCaptureData(snapshot) : snapshot;
    return {
      data: terminalSnapshotData(snapshotData, state, savedMainSnapshot, physicalSnapshot),
      history: { loaded: loadedHistory, available: availableHistory },
    };
  };

  const sendControlInput = async (data: string): Promise<void> => {
    for (const command of terminalInputControlCommands(paneId, data)) {
      await runControlCommand(command);
    }
  };

  const sendTerminalSubmission = async (data: string, bracketedPaste: boolean): Promise<void> => {
    await sendControlInput(terminalSubmissionData(data, bracketedPaste));
    if (closed) return;
    await new Promise((resolve) => setTimeout(resolve, terminalSubmissionSettleMs(bracketedPaste)));
    if (!closed) await runControlCommand(`send-keys -t ${paneId} Enter`);
  };

  const assertInputAllowed = async (): Promise<void> => {
    if ((await options.canInput?.()) === false) {
      throw new Error('King controls this workspace. Take control before sending terminal input.');
    }
  };

  const queueTerminalInput = (data: string, operation: () => Promise<void>): void => {
    const bytes = Buffer.byteLength(data);
    if (bytes > MAX_INPUT_BYTES) throw new Error('Input is too large.');
    if (pendingInputBytes + bytes > MAX_PENDING_INPUT_BYTES) {
      message(socket, { type: 'error', message: 'Terminal input was paused because the server fell behind.' });
      socket.close(1013, 'terminal input fell behind');
      return;
    }
    pendingInputBytes += bytes;
    if (syntheticOutputDepth === 0) syntheticOutputUntil = 0;
    inputQueue = inputQueue
      .then(operation)
      .catch((error) =>
        message(socket, {
          type: 'error',
          message: error instanceof Error ? error.message : 'Terminal input failed.',
        })
      )
      .finally(() => {
        pendingInputBytes -= bytes;
      });
  };

  const waitForTerminalRedraw = async (): Promise<void> => {
    const startedAt = Date.now();
    const deadline = Date.now() + TERMINAL_REDRAW_SETTLE_LIMIT_MS;
    let observedVersion = terminalOutputVersion;
    let quietSince = Date.now();
    while (!closed && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, TERMINAL_REDRAW_POLL_MS));
      if (terminalOutputVersion !== observedVersion) {
        observedVersion = terminalOutputVersion;
        quietSince = Date.now();
        continue;
      }
      if (Date.now() - startedAt >= TERMINAL_REDRAW_GRACE_MS && Date.now() - quietSince >= TERMINAL_REDRAW_QUIET_MS)
        return;
    }
  };

  const withSyntheticOutput = async <T>(
    operation: () => Promise<T>,
    settleMs = SYNTHETIC_OUTPUT_SETTLE_MS
  ): Promise<T> => {
    syntheticOutputDepth += 1;
    options.onSyntheticOutput?.(Date.now() + settleMs);
    try {
      const result = await operation();
      // tmux may finish the resize command before its control-mode redraw
      // notifications arrive. Capturing immediately can therefore restore the
      // previous device's grid after the pane already has its new geometry.
      await waitForTerminalRedraw();
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
    }
  };

  const sendTerminalOutput = (output: string): void => {
    const alternateScreenExit = terminalAlternateScreenExitState(terminalControlSequenceTail, output);
    terminalControlSequenceTail = alternateScreenExit.tail;
    const now = Date.now();
    if (snapshotAcknowledged && (syntheticOutputDepth > 0 || options.isOutputSuppressed?.() === true)) {
      if (alternateScreenExit.exited) scheduleAlternateScreenExitResync();
      return;
    }
    const locallyEligible = snapshotAcknowledged && syntheticOutputDepth === 0 && now >= syntheticOutputUntil;
    const activity = isTerminalOutputActivity(
      {
        snapshotAcknowledged,
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
    if (!snapshotSent) return;
    if (snapshotAcknowledged) {
      message(socket, { type: 'output', data: output, activity, activityAt });
      if (alternateScreenExit.exited) scheduleAlternateScreenExitResync();
      return;
    }

    const bytes = Buffer.byteLength(output);
    if (pendingSnapshotOutputBytes + bytes > MAX_SNAPSHOT_OUTPUT_QUEUE_BYTES) {
      message(socket, { type: 'error', message: 'Terminal output arrived before the screen was ready.' });
      socket.close(1013, 'terminal snapshot fell behind');
      return;
    }
    pendingSnapshotOutput.push({ data: output, activity, activityAt });
    pendingSnapshotOutputBytes += bytes;
    if (alternateScreenExit.exited) scheduleAlternateScreenExitResync();
  };

  const acknowledgeSnapshot = (): void => {
    if (!snapshotSent || snapshotAcknowledged || closed) return;
    snapshotAcknowledged = true;
    const pending = pendingSnapshotOutput;
    pendingSnapshotOutput = [];
    pendingSnapshotOutputBytes = 0;
    for (const output of pending) message(socket, { type: 'output', ...output });
    if (alternateScreenExitResyncRequested) scheduleAlternateScreenExitResync();
  };

  const loadTerminalHistory = async (lines: number): Promise<void> => {
    if (closed) return;
    snapshotSent = false;
    snapshotAcknowledged = false;
    pendingSnapshotOutput = [];
    pendingSnapshotOutputBytes = 0;
    try {
      const geometry = options.getGeometry?.() ?? currentGeometry;
      const snapshot = await captureTerminalSnapshot(lines, geometry);
      if (closed) return;
      snapshotSent = true;
      message(socket, { type: 'snapshot', data: snapshot.data, history: snapshot.history });
      message(socket, { type: 'screen-ready' });
    } catch (error) {
      if (!closed) socket.close(1013, 'terminal history synchronization failed');
      throw error;
    }
  };

  async function resyncTerminalScreen(geometry?: TerminalSize): Promise<void> {
    if (!snapshotSent || closed) return;
    if (geometry) {
      const expected = `${geometry.columns}x${geometry.rows}`;
      let applied = false;
      for (let attempt = 0; attempt < 100 && !closed; attempt += 1) {
        const actual = await runControlCommand(`display-message -p -t ${paneId} '#{pane_width}x#{pane_height}'`);
        if (actual.trim() === expected) {
          applied = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (!applied) throw new Error('Terminal geometry did not settle before screen synchronization.');
    } else {
      await runControlCommand(SYNTHETIC_OUTPUT_BARRIER);
    }
    const synchronizedGeometry = geometry ?? options.getGeometry?.() ?? currentGeometry;
    // A capture contains cells, not terminal modes, the cursor, or the main
    // screen saved behind an active TUI. Queue the related control commands so
    // a browser can continue from the same terminal state after reconstruction.
    const [snapshot, rawState, savedMainSnapshot, physicalSnapshot] = await Promise.all([
      runControlCommand(`capture-pane -p -e -J -t ${paneId}`),
      runControlCommand(`display-message -p -t ${paneId} '${TERMINAL_PANE_STATE_FORMAT}'`),
      runControlCommand(`capture-pane -p -e -J -a -q -t ${paneId}`),
      runControlCommand(`capture-pane -p -e -N -t ${paneId}`),
    ]);
    message(socket, {
      type: 'output',
      data: terminalScreenData(
        snapshot,
        terminalPaneState(rawState, synchronizedGeometry),
        savedMainSnapshot,
        physicalSnapshot
      ),
      activity: false,
      activityAt: null,
      screenSync: true,
    });
  }

  function scheduleAlternateScreenExitResync(): void {
    if (!snapshotSent || closed) return;
    alternateScreenExitResyncRequested = true;
    if (!snapshotAcknowledged || alternateScreenExitResyncPending) return;
    alternateScreenExitResyncPending = true;
    setTimeout(() => {
      void (async () => {
        while (alternateScreenExitResyncRequested && !closed) {
          alternateScreenExitResyncRequested = false;
          await resyncTerminalScreen();
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

  const handleControlLine = (lineBuffer: Buffer): void => {
    const output = parseTmuxControlOutput(lineBuffer, paneId, terminalDecoder);
    if (output !== undefined) {
      terminalOutputVersion += 1;
      sendTerminalOutput(output);
      return;
    }
    const line = lineBuffer.toString('utf8');
    if (line.startsWith('%begin ')) {
      commandBlock = { command: pendingCommands.shift(), output: [] };
      return;
    }
    if (commandBlock) {
      if (line.startsWith('%end ') || line.startsWith('%error ')) {
        const completed = commandBlock;
        commandBlock = undefined;
        if (!completed.command) return;
        clearTimeout(completed.command.timer);
        if (line.startsWith('%error ')) {
          completed.command.reject(new Error(completed.output.join('\n') || 'tmux command failed.'));
          return;
        }
        const output = completed.output.length > 0 ? `${completed.output.join('\n')}\n` : '';
        try {
          completed.command.onSuccess?.(output);
          completed.command.resolve(output);
        } catch (error) {
          completed.command.reject(error);
        }
        return;
      }
      commandBlock.output.push(line);
      return;
    }
    if (line.startsWith('%session-changed ')) attachedResolve();
  };

  control.stdout.on('data', (chunk: Buffer) => {
    const buffer = controlLineBuffer.length > 0 ? Buffer.concat([controlLineBuffer, chunk]) : chunk;
    let lineStart = 0;
    for (let index = 0; index < buffer.length; index += 1) {
      if (buffer[index] !== 0x0a) continue;
      handleControlLine(buffer.subarray(lineStart, index));
      lineStart = index + 1;
    }
    controlLineBuffer = lineStart === buffer.length ? Buffer.alloc(0) : Buffer.from(buffer.subarray(lineStart));
  });

  control.once('error', (error) => {
    rejectControlCommands(error);
    if (!closed) message(socket, { type: 'error', message: 'Could not attach to the tmux session.' });
  });
  control.once('exit', () => {
    rejectControlCommands(new Error('tmux control client exited.'));
    if (!closed) {
      message(socket, { type: 'error', message: 'The tmux session is no longer available.' });
      socket.close(1011, 'tmux session unavailable');
    }
  });
  socket.once('close', () => {
    closed = true;
    options.onSyntheticOutput?.(Date.now() + SYNTHETIC_OUTPUT_SETTLE_MS);
    pendingSnapshotOutput = [];
    pendingSnapshotOutputBytes = 0;
    controlLineBuffer = Buffer.alloc(0);
    control.stdin.end();
    control.kill();
  });

  const resizeControlClient = async (): Promise<void> => {
    if (resizing || closed || sizeIgnored || options.canResize?.() === false) return;
    resizing = true;
    try {
      while (requestedSize && !closed && options.canResize?.() !== false) {
        const next = requestedSize;
        requestedSize = undefined;
        const key = `${next.columns}x${next.rows}`;
        if (key === appliedSize) continue;
        const previousGeometry = currentGeometry;
        currentGeometry = next;
        options.onGeometryChange?.(next);
        try {
          await withSyntheticOutput(async () => {
            await runControlCommand(`refresh-client -C ${key}`);
            await runControlCommand(SYNTHETIC_OUTPUT_BARRIER);
          }, TERMINAL_RESIZE_SETTLE_MS);
          await options.onResizeComplete?.(next);
          appliedSize = key;
        } catch (error) {
          currentGeometry = previousGeometry;
          options.onGeometryChange?.(previousGeometry);
          throw error;
        }
      }
    } catch (error) {
      message(socket, { type: 'error', message: error instanceof Error ? error.message : 'Terminal resize failed.' });
    } finally {
      resizing = false;
      if (requestedSize && !closed) void resizeControlClient();
    }
  };

  const setIgnoreSize = async (ignored: boolean): Promise<void> => {
    if (closed) return;
    if (!ignored && sizeIgnored) {
      // Geometry broadcasts resize every xterm to the shared pane, so a passive
      // browser may not send its unchanged fit again. Retain its last requested
      // device size and restore that preference when it takes control.
      requestedSize ??= preferredSize;
      while (requestedSize && !closed) {
        const next = requestedSize;
        requestedSize = undefined;
        const key = `${next.columns}x${next.rows}`;
        const previousGeometry = currentGeometry;
        currentGeometry = next;
        // A control client can emit redraw output as soon as its size changes,
        // even while tmux still marks it ignore-size. Every browser must resize
        // before that output is allowed onto the shared terminal stream.
        options.onGeometryChange?.(next);
        try {
          await runControlCommand(`refresh-client -C ${key}`);
          appliedSize = key;
        } catch (error) {
          currentGeometry = previousGeometry;
          options.onGeometryChange?.(previousGeometry);
          throw error;
        }
      }
      // Announce the geometry before tmux emits the redraw caused by this client
      // becoming authoritative, so every browser renders the same grid.
      options.onGeometryChange?.(currentGeometry);
      await withSyntheticOutput(async () => {
        await runControlCommand('refresh-client -f !ignore-size');
        // While ignore-size is set, -C updates only this client. Repeat it after
        // promotion so the pane has reached the announced geometry before capture.
        await runControlCommand(`refresh-client -C ${currentGeometry.columns}x${currentGeometry.rows}`);
        await runControlCommand(SYNTHETIC_OUTPUT_BARRIER);
      }, TERMINAL_RESIZE_SETTLE_MS);
      await options.onResizeComplete?.(currentGeometry);
      sizeIgnored = false;
    } else if (ignored && !sizeIgnored) {
      await withSyntheticOutput(() => runControlCommand('refresh-client -f ignore-size'));
      sizeIgnored = true;
    }
    if (!ignored) await resizeControlClient();
  };

  socket.on('message', (raw, isBinary) => {
    if (isBinary || closed) return;
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
        queueTerminalInput('', async () => {
          await options.onActivate?.();
        });
      } else if (input.type === 'snapshot-ready') {
        acknowledgeSnapshot();
      } else if (input.type === 'load-history') {
        if (options.lazyHistory && snapshotAcknowledged && !historyCapturePending) {
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
          await assertInputAllowed();
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
        queueTerminalInput(input.data, async () => {
          await assertInputAllowed();
          options.onInput?.();
          await sendTerminalSubmission(input.data, input.bracketedPaste);
        });
      } else if (input.type === 'resize') {
        preferredSize = { columns: input.columns, rows: input.rows };
        requestedSize = preferredSize;
        queueTerminalInput('', resizeControlClient);
      }
    } catch (error) {
      message(socket, { type: 'error', message: error instanceof Error ? error.message : 'Terminal input failed.' });
    }
  });

  await attached;
  await options.onAttached?.(setIgnoreSize, resyncTerminalScreen);
  if (requestedSize) await resizeControlClient();
  const snapshotGeometry = options.getGeometry?.() ?? currentGeometry;
  if (options.sendGeometry)
    message(socket, {
      type: 'geometry',
      ...snapshotGeometry,
      ...(options.hasControl ? { active: options.hasControl() } : {}),
    });
  const snapshot = await captureTerminalSnapshot(options.lazyHistory ? 0 : snapshotHistoryLines, snapshotGeometry);
  snapshotSent = true;
  message(socket, {
    type: 'snapshot',
    data: snapshot.data,
    ...(options.lazyHistory ? { history: snapshot.history } : {}),
  });
  message(socket, { type: 'screen-ready' });
  if (requestedSize) void resizeControlClient();
}
