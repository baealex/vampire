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
const TERMINAL_INITIAL_OUTPUT_WAIT_MS = 1_000;
const TERMINAL_INITIAL_OUTPUT_POLL_MS = 10;
// A control-mode command after a capture establishes the sequence boundary
// between the snapshot and the live %output stream.
const TERMINAL_OUTPUT_FENCE = 'display-message -p vampire-output-fence';
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

export type TerminalSizeController = (ignored: boolean) => Promise<void>;
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
  hasControl?: () => boolean;
  sendGeometry?: boolean;
  snapshotIds?: boolean;
  outputSequences?: boolean;
  submissionResults?: boolean;
  scheduleOperation?: TerminalOperationScheduler;
  onAttached?: (setIgnoreSize: TerminalSizeController) => Promise<void> | void;
  onActivate?: () => Promise<void> | void;
  onGeometryChange?: (geometry: TerminalSize) => void;
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

export function terminalCaptureFlag(state: TerminalPaneState | undefined, loadedHistory: number): '-J' | '-N' {
  // The visible screen must retain physical cells whose only content is a
  // background color. Joined captures are still useful for explicit history
  // loads, where preserving soft-wrapped scrollback is more important.
  return state?.alternateScreen || loadedHistory <= 0 ? '-N' : '-J';
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

interface QueuedOutput {
  data: string;
  activity: boolean;
  activityAt: number | null;
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
  const controlLease = retainTerminalControlHub(tmuxSession, windowId, paneId, targetGeometry);
  const controlHub = controlLease.hub;
  const sizeOwner = {};
  let closed = false;
  const inputAllowed = () => !closed && options.isAuthorized?.() !== false;
  let snapshotId = 0;
  let pendingSnapshotId: number | undefined;
  const terminalDelivery = new TerminalDeliveryBuffer<QueuedOutput>(MAX_SNAPSHOT_OUTPUT_QUEUE_BYTES);
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
  let lastOutputActivityNotice = 0;
  let sizeIgnored = Boolean(options.ignoreSize);
  let historyCapturePending = false;
  let loadedHistoryLines = options.lazyHistory ? 0 : snapshotHistoryLines;
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
  const waitForTerminalGeometry = async (geometry: TerminalSize): Promise<void> => {
    const expected = `${geometry.columns}x${geometry.rows}`;
    for (let attempt = 0; attempt < 100 && !closed; attempt += 1) {
      const actual = await runControlCommand(`display-message -p -t ${paneId} '#{pane_width}x#{pane_height}'`);
      if (actual.trim() === expected) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Terminal geometry did not settle before establishing a screen snapshot.');
  };
  const captureTerminalSnapshot = async (
    requestedHistoryLines: number,
    geometry: TerminalSize
  ): Promise<{ data: string; history: TerminalHistoryState; throughSequence: number }> => {
    // A snapshot is a slow recovery operation, never the live rendering path.
    // Capture the pane from tmux and fence it with a control command so the
    // browser receives every later raw byte after this frame.
    for (let attempt = 0; attempt < 20 && !closed; attempt += 1) {
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
      const captureFlag = terminalCaptureFlag(state, loadedHistory);
      const historyFlag = captureFlag === '-J' && loadedHistory > 0 ? ` -S -${loadedHistory}` : '';
      const [snapshot, savedMainSnapshot, physicalSnapshot] = await Promise.all([
        runControlCommand(`capture-pane -p -e ${captureFlag}${historyFlag} -t ${paneId}`),
        runControlCommand(`capture-pane -p -e -N -a -q -t ${paneId}`),
        runControlCommand(`capture-pane -p -e -N -t ${paneId}`),
      ]);
      if (controlHub.outputVersion !== outputVersion) continue;
      const snapshotData = captureFlag === '-N' ? terminalPhysicalCaptureData(snapshot) : snapshot;
      const savedMainData = terminalRecordData(savedMainSnapshot);
      const visibleSavedMainData = savedMainData.split('\n').slice(-geometry.rows).join('\n');
      const captured = {
        data: terminalSnapshotData(snapshotData, state, visibleSavedMainData, physicalSnapshot),
        history: { loaded: loadedHistory, available: availableHistory },
      };
      // The barrier is deliberately after capture: output emitted while the
      // capture was in flight must make us retry, while output after the
      // barrier receives a sequence greater than the snapshot fence.
      await runControlCommand(TERMINAL_OUTPUT_FENCE);
      if (controlHub.outputVersion !== outputVersion) continue;
      return { ...captured, throughSequence: controlHub.outputSequence };
    }
    throw new Error('Terminal output did not settle while establishing an authoritative snapshot.');
  };

  const terminalSnapshot = async (
    requestedHistoryLines: number,
    geometry: TerminalSize
  ): Promise<{ data: string; history: TerminalHistoryState; throughSequence: number }> =>
    captureTerminalSnapshot(requestedHistoryLines, geometry);

  const closeForOversizedScreen = (): void => {
    sendTerminalMessage(socket, {
      type: 'error',
      message: 'This terminal screen is too large to display safely. Reduce the pane size and reconnect.',
    });
    socket.close(1009, 'terminal screen exceeds limit');
  };

  const runResizeControlCommand = async (
    geometry: TerminalSize,
    onCommitted: () => void,
    onFailed?: () => void
  ): Promise<void> => {
    // tmux may emit the SIGWINCH redraw before the control command's %end
    // record. Hold only that short raw-output window so every browser receives
    // the geometry notification before it parses the redraw at the new size.
    // The output is not replaced, parsed, or refreshed; it is released in order.
    const releaseOutput = controlHub.pauseOutput();
    try {
      await runControlCommand(`refresh-client -C ${geometry.columns}x${geometry.rows}`);
      onCommitted();
    } catch (error) {
      onFailed?.();
      throw error;
    } finally {
      releaseOutput();
    }
  };

  const boundedTerminalSnapshot = async (
    requestedHistoryLines: number,
    geometry: TerminalSize
  ): ReturnType<typeof terminalSnapshot> => {
    let snapshot = await terminalSnapshot(requestedHistoryLines, geometry);
    while (
      terminalEncodedScreenDataBytes(snapshot.data) > MAX_TERMINAL_ENCODED_SCREEN_DATA_BYTES &&
      snapshot.history.loaded > 0
    ) {
      const reducedHistory = Math.floor(snapshot.history.loaded / 2);
      snapshot = await terminalSnapshot(reducedHistory, geometry);
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

  const waitForInitialTerminalContent = async (): Promise<void> => {
    const outputVersion = controlHub.outputVersion;
    const visiblePane = await runControlCommand(`capture-pane -p -t ${paneId}`);
    if (visiblePane.trim() || controlHub.outputVersion !== outputVersion) return;

    const deadline = Date.now() + TERMINAL_INITIAL_OUTPUT_WAIT_MS;
    while (!closed && controlHub.outputVersion === outputVersion && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, TERMINAL_INITIAL_OUTPUT_POLL_MS));
    }
  };

  const sendDeliveryBatch = (batch: TerminalDeliveryBatch<QueuedOutput>): void => {
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
    const now = Date.now();
    const activity = terminalDelivery.acknowledged;
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
  };

  const acknowledgeSnapshot = (acknowledgedSnapshotId?: number): void => {
    if (!terminalDelivery.snapshotSent || terminalDelivery.acknowledged || closed) return;
    if (options.snapshotIds && acknowledgedSnapshotId !== pendingSnapshotId) return;
    sendDeliveryBatch(terminalDelivery.acknowledge());
  };

  const loadTerminalHistory = async (lines: number): Promise<void> => {
    if (closed) return;
    terminalDelivery.beginSnapshot();
    try {
      const geometry = options.getGeometry?.() ?? currentGeometry;
      const snapshot = await boundedTerminalSnapshot(lines, geometry);
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
        const key = `${next.columns}x${next.rows}`;
        if (key === appliedSize) continue;
        const previousGeometry = currentGeometry;
        try {
          currentGeometry = next;
          await runResizeControlCommand(
            next,
            () => {
              appliedSize = key;
              lastControlledSize = next;
              options.onGeometryChange?.(next);
            },
            () => {
              currentGeometry = previousGeometry;
              options.onGeometryChange?.(previousGeometry);
            }
          );
        } catch (error) {
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
      while (requestedSize && !closed) {
        const requested = requestedSize;
        requestedSize = undefined;
        const next = requested;
        const key = `${next.columns}x${next.rows}`;
        const previousGeometry = currentGeometry;
        try {
          currentGeometry = next;
          await runResizeControlCommand(
            next,
            () => {
              appliedSize = key;
              lastControlledSize = next;
              options.onGeometryChange?.(next);
            },
            () => {
              currentGeometry = previousGeometry;
              options.onGeometryChange?.(previousGeometry);
            }
          );
        } catch (error) {
          throw error;
        }
      }
      if (firstSizeOwner) await runControlCommand('refresh-client -f !ignore-size');
      sizeIgnored = false;
    } else if (ignored && !sizeIgnored) {
      if (controlHub.releaseSize(sizeOwner)) await runControlCommand('refresh-client -f ignore-size');
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
      } else if (input.type === 'refresh-screen') {
        if (terminalDelivery.acknowledged && !historyCapturePending) {
          historyCapturePending = true;
          queueTerminalInput('', async () => {
            try {
              await loadTerminalHistory(0);
            } finally {
              historyCapturePending = false;
            }
          });
        }
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
  await options.onAttached?.(setIgnoreSize);
  if (!inputAllowed()) return;
  if (requestedSize) await scheduleTerminalOperation(resizeControlClient);
  const initialSnapshot = await scheduleTerminalOperation(async () => {
    const geometry = options.getGeometry?.() ?? currentGeometry;
    await waitForTerminalGeometry(geometry);
    await waitForInitialTerminalContent();
    const snapshot = await boundedTerminalSnapshot(options.lazyHistory ? 0 : snapshotHistoryLines, geometry);
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
