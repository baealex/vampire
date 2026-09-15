import type { FitAddon } from '@xterm/addon-fit';
import type { ITheme, Terminal } from '@xterm/xterm';
import {
  parseTerminalColorReports,
  type TerminalColorSlot,
  terminalThemeColor,
} from '~/lib/shared/contracts/terminal-color.ts';
import {
  TERMINAL_HISTORY_CHUNK_LINES,
  TERMINAL_PROTOCOL_VERSION,
  TERMINAL_SCROLLBACK_LINES,
  type TerminalHistoryState,
  type TerminalServerMessage,
  type TerminalSubmissionResult,
} from '~/lib/shared/contracts/terminal-protocol.ts';
import { usesCommandKeyForShortcuts } from '~/lib/shared/ui/keyboard.ts';
import { hasFinePointer } from '~/lib/shared/ui/layout.ts';
import { TerminalConnection, type TerminalConnectionContext } from '../api/connection.ts';
import {
  isInputSurfaceToggleShortcut,
  type TerminalControlKey,
  terminalControlData,
  terminalScrollCommand,
} from '../model/terminal-control.ts';
import { loadTerminalFontSize, TERMINAL_FONT_SIZE_KEY } from '../model/terminal-display-preference.ts';
import { fitTerminalToVisibleArea, type TerminalSize, terminalSizeForVisibleArea } from './fit.ts';
import { TerminalOutputSequence } from './output-sequence.ts';
import { installTerminalTouchScroll } from './touch-scroll.ts';

const OPENING_DELAY_MS = 160;
const OUTPUT_ACTIVE_MS = 2_500;
const INPUT_ACTIVITY_NOTICE_MS = 750;
const OUTPUT_ACTIVITY_NOTICE_MS = 500;
const TERMINAL_RESIZE_DEBOUNCE_MS = 64;

export type TerminalOpeningStage = 'opening' | 'attaching' | 'restoring';

export interface TerminalRuntimeState {
  connected: boolean;
  controlSizeMismatch: boolean;
  controlsTerminal: boolean | undefined;
  error: string;
  inputReady: boolean;
  openingStage: TerminalOpeningStage;
  openingVisible: boolean;
  reconnecting: boolean;
  screenReady: boolean;
}

export interface TerminalRuntimeOptions {
  element: HTMLDivElement;
  workspaceId: string;
  terminalId?: string;
  fontSize: number;
  minimumFontSize: number;
  maximumFontSize: number;
  themeChangeEvent: string;
  getFontFamily: () => string;
  getTheme: () => ITheme;
  shouldAutoFocus: () => boolean;
  onFontSizeChange: (size: number) => void;
  onComposeShortcut: () => void;
  onInputActivity: (workspaceId: string, timestamp: number) => void;
  onTerminalInput: () => void;
  onOutputActivity: (workspaceId: string, active: boolean, timestamp?: number) => void;
  onRepositoryStatus: (changeCount: number, worktreeCount: number, branch?: string) => void;
  onStateChange: (state: Readonly<TerminalRuntimeState>) => void;
  onTerminalTap: () => void;
  onSubmissionResult?: (result: TerminalSubmissionResult) => void;
  onSubmissionUncertain?: (requestId?: string) => void;
}

interface TerminalHistoryAnchor {
  baseY: number;
  viewportY: number;
  revealLines: number;
  toTop: boolean;
}

interface PendingTerminalSnapshot {
  context: TerminalConnectionContext;
  data: string;
  generation: number;
  history?: TerminalHistoryState;
  rendered: boolean;
  serverReady: boolean;
  snapshotId?: number;
  written: boolean;
}

type ActiveTerminalWrite = { kind: 'output' } | { generation: number; kind: 'snapshot' };

export class TerminalRuntime {
  #entryClaimPending = true;
  #clientId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
  #connectionAttempt = 0;
  #controlRefreshPending = false;
  #connection: TerminalConnection | undefined;
  #destroyed = false;
  #fit: FitAddon | undefined;
  #fontSize: number;
  #geometryConnectionId = 0;
  #historyAnchor: TerminalHistoryAnchor | undefined;
  #historyAvailable = 0;
  #historyChunkLines: number = TERMINAL_HISTORY_CHUNK_LINES.standard;
  #historyEnabled = false;
  #historyLoadPending = false;
  #historyLoaded = 0;
  #historyMayHaveGrown = false;
  #historyMaximum: number = TERMINAL_SCROLLBACK_LINES.standard;
  #inputDisposable: { dispose(): void } | undefined;
  #inputNoticeAt = 0;
  #initialSnapshotReceived = false;
  #lastOutputActivityNotice = 0;
  #lastSentSize = '';
  #openingDelay: ReturnType<typeof setTimeout> | undefined;
  #options: TerminalRuntimeOptions;
  #outputActive = false;
  #outputActivityTimer: ReturnType<typeof setTimeout> | undefined;
  #reconnectExhausted = false;
  #removeTouchScroll: () => void = () => undefined;
  #requestedSize: TerminalSize | undefined;
  #resizeFrame: number | undefined;
  #resizeTimer: ReturnType<typeof setTimeout> | undefined;
  #screenRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  #outputFrame: number | undefined;
  #outputSequence = new TerminalOutputSequence();
  #activeTerminalWrite: ActiveTerminalWrite | undefined;
  #pendingOutput = '';
  #pendingSnapshot: PendingTerminalSnapshot | undefined;
  #renderDisposable: { dispose(): void } | undefined;
  #snapshotGeneration = 0;
  #scrollDisposable: { dispose(): void } | undefined;
  #sentSizeConnection = 0;
  #sharedGeometry: TerminalSize | undefined;
  #started = false;
  #initialFocusPending = true;
  #submissionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  #state: TerminalRuntimeState = {
    connected: false,
    controlSizeMismatch: false,
    controlsTerminal: undefined,
    error: '',
    inputReady: false,
    openingStage: 'opening',
    openingVisible: false,
    reconnecting: false,
    screenReady: false,
  };
  #terminal: Terminal | undefined;
  #resizeObserver: ResizeObserver | undefined;

  constructor(options: TerminalRuntimeOptions) {
    this.#options = options;
    this.#fontSize = options.fontSize;
    options.onSubmissionUncertain?.();
  }

  get connected(): boolean {
    return this.#state.connected;
  }

  #scheduleInitialFocus(): void {
    requestAnimationFrame(() => {
      if (!this.#destroyed && this.#state.inputReady && hasFinePointer() && this.#options.shouldAutoFocus()) {
        this.#terminal?.focus();
      }
    });
  }

  #installInteractionListeners(): void {
    window.addEventListener('focus', this.#handleVisibilityChange);
    window.addEventListener('online', this.#handleOnline);
    window.addEventListener(this.#options.themeChangeEvent, this.#handleThemeChange);
    document.addEventListener('visibilitychange', this.#handleVisibilityChange);
    this.#options.element.addEventListener('wheel', this.#handleTerminalWheel, { passive: true });
    this.#removeTouchScroll = installTerminalTouchScroll(this.#options.element, () => this.#terminal, {
      onScrollAttempt: (lines) => this.#handleTerminalTouchScroll(lines),
      onTap: this.#options.onTerminalTap,
      useNativeInteraction: () => true,
    });
  }

  #removeInteractionListeners(): void {
    window.removeEventListener('focus', this.#handleVisibilityChange);
    window.removeEventListener('online', this.#handleOnline);
    window.removeEventListener(this.#options.themeChangeEvent, this.#handleThemeChange);
    document.removeEventListener('visibilitychange', this.#handleVisibilityChange);
    this.#options.element.removeEventListener('wheel', this.#handleTerminalWheel);
    this.#removeTouchScroll();
  }

  start(): void {
    if (this.#started || this.#destroyed) return;
    this.#started = true;
    this.#options.element.lang = navigator.language || 'und';
    this.#openingDelay = setTimeout(() => {
      this.#openingDelay = undefined;
      if (!this.#state.screenReady && !this.#state.error) this.#updateState({ openingVisible: true });
    }, OPENING_DELAY_MS);
    this.#installInteractionListeners();
    void this.#openTerminal();
  }

  claimControl(): void {
    const preferred = this.#requestedSize;
    if (preferred) this.#connection?.send({ type: 'resize', ...preferred });
    else this.#sendSize();
    this.#connection?.send({ type: 'activate' });
  }

  focus(): void {
    if (!this.#state.inputReady) {
      this.#initialFocusPending = true;
      return;
    }
    this.#terminal?.focus();
  }

  scrollToTop(): void {
    if (!this.#requestHistory({ toTop: true, loadAll: true })) this.#terminal?.scrollToTop();
  }

  scrollPageUp(): void {
    const terminal = this.#terminal;
    if (!terminal) return;
    if (
      terminal.buffer.active.type === 'normal' &&
      terminal.buffer.active.viewportY === 0 &&
      this.#requestHistory({ revealLines: -Math.max(1, terminal.rows - 1) })
    )
      return;
    terminal.scrollPages(-1);
  }

  scrollPageDown(): void {
    this.#terminal?.scrollPages(1);
  }

  scrollToBottom(): void {
    this.#terminal?.scrollToBottom();
  }

  send(data: string): boolean {
    if (this.#destroyed || !this.#state.inputReady || !this.#connection?.send({ type: 'input', data })) return false;
    this.#markInputActivity();
    return true;
  }

  sendControl(control: TerminalControlKey): void {
    this.send(terminalControlData(control, this.#terminal?.modes.applicationCursorKeysMode === true));
  }

  submit(data: string, requestId?: string): boolean {
    const terminal = this.#terminal;
    if (
      !terminal ||
      this.#destroyed ||
      !this.#state.inputReady ||
      !this.#connection?.send({
        type: 'submit',
        data,
        ...(requestId ? { requestId } : {}),
        bracketedPaste: terminal.modes.bracketedPasteMode && terminal.options.ignoreBracketedPasteMode !== true,
      })
    )
      return false;
    if (requestId) {
      const timer = setTimeout(() => {
        this.#submissionTimers.delete(requestId);
        this.#options.onSubmissionUncertain?.(requestId);
      }, 30_000);
      this.#submissionTimers.set(requestId, timer);
    }
    this.#markInputActivity();
    return true;
  }

  #markSubmissionsUncertain(): void {
    for (const timer of this.#submissionTimers.values()) clearTimeout(timer);
    this.#submissionTimers.clear();
    this.#options.onSubmissionUncertain?.();
  }

  setFontSize(size: number): void {
    if (!Number.isFinite(size)) return;
    const next = Math.min(this.#options.maximumFontSize, Math.max(this.#options.minimumFontSize, size));
    this.#fontSize = next;
    try {
      window.localStorage.setItem(TERMINAL_FONT_SIZE_KEY, String(next));
    } catch {
      // A browser storage policy must not disable terminal input or resizing.
    }
    if (!this.#terminal || this.#terminal.options.fontSize === next) return;
    this.#terminal.options.fontSize = next;
    this.#scheduleResize();
  }

  reconnect(): void {
    if (this.#destroyed) return;
    this.#reconnectExhausted = false;
    this.#updateState({ error: '', reconnecting: true });
    this.#connection?.retryNow();
  }

  dispose(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#markSubmissionsUncertain();
    this.#removeInteractionListeners();
    if (this.#outputActivityTimer) clearTimeout(this.#outputActivityTimer);
    this.#cancelScheduledResize();
    this.#cancelScheduledOutput();
    if (this.#openingDelay) clearTimeout(this.#openingDelay);
    if (this.#screenRefreshTimer) clearTimeout(this.#screenRefreshTimer);
    this.#setOutputActive(false);
    this.#resizeObserver?.disconnect();
    this.#inputDisposable?.dispose();
    this.#scrollDisposable?.dispose();
    this.#renderDisposable?.dispose();
    this.#connection?.stop();
    this.#terminal?.dispose();
  }

  async #openTerminal(): Promise<void> {
    const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]);
    if (this.#destroyed) return;
    const scrollback = TERMINAL_SCROLLBACK_LINES.standard;
    this.#historyMaximum = scrollback;
    this.#historyChunkLines = TERMINAL_HISTORY_CHUNK_LINES.standard;
    this.#fontSize = loadTerminalFontSize(this.#fontSize);
    this.#options.onFontSizeChange(this.#fontSize);

    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      disableStdin: false,
      fontSize: this.#fontSize,
      lineHeight: 1.2,
      fontFamily: this.#options.getFontFamily(),
      // Preserve xterm's pending-wrap cursor line when the shared pane is
      // resized. Without the library's own reflow, one cursor row can remain
      // in the old position after a device handoff.
      reflowCursorLine: true,
      theme: this.#options.getTheme(),
      scrollback,
      scrollOnUserInput: true,
      smoothScrollDuration: 0,
    });
    this.#terminal = terminal;
    const fitAddon = new FitAddon();
    this.#fit = fitAddon;
    terminal.loadAddon(fitAddon);
    terminal.open(this.#options.element);
    this.#renderDisposable = terminal.onRender(() => {
      const snapshot = this.#pendingSnapshot;
      if (!snapshot || !snapshot.written || snapshot.rendered) return;
      snapshot.rendered = true;
      this.#finishSnapshotIfReady(snapshot);
    });
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.isComposing || event.keyCode === 229) return true;
      const scrollCommand = terminalScrollCommand(event);
      if (scrollCommand) {
        event.preventDefault();
        if (event.type === 'keydown') {
          if (scrollCommand === 'top') this.scrollToTop();
          else if (scrollCommand === 'bottom') this.scrollToBottom();
          else if (scrollCommand === 'up') this.scrollPageUp();
          else this.scrollPageDown();
        }
        return false;
      }
      if (isInputSurfaceToggleShortcut(event, usesCommandKeyForShortcuts())) {
        event.preventDefault();
        event.stopPropagation();
        if (event.type === 'keydown') this.#options.onComposeShortcut();
        return false;
      }
      if (event.key !== 'Enter' || !event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return true;
      event.preventDefault();
      if (event.type === 'keydown') this.send('\u001b[13;2u');
      return false;
    });
    this.#inputDisposable = terminal.onData((data) => this.#handleTerminalData(data));
    this.#scrollDisposable = terminal.onScroll((viewportY) => {
      if (viewportY === 0) this.#requestHistory();
    });

    const initialSize = fitTerminalToVisibleArea(fitAddon, (columns, rows) => terminal.resize(columns, rows));
    this.#requestedSize = initialSize;
    const websocketUrl = new URL(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/terminal`);
    websocketUrl.searchParams.set('workspace', this.#options.workspaceId);
    websocketUrl.searchParams.set('history', String(scrollback));
    // Attach with the current visible pane only. Retained scrollback is loaded
    // only after the user explicitly scrolls up; replaying it during workspace
    // entry makes a normal terminal feel like a remote screen playback.
    websocketUrl.searchParams.set('history-mode', 'lazy');
    websocketUrl.searchParams.set('protocol', String(TERMINAL_PROTOCOL_VERSION));
    if (this.#options.terminalId) websocketUrl.searchParams.set('terminal', this.#options.terminalId);
    this.#connection = new TerminalConnection(
      () => {
        const url = new URL(websocketUrl);
        url.searchParams.set('client-id', this.#clientId);
        url.searchParams.set('connection-attempt', String(++this.#connectionAttempt));
        const requestedSize = this.#requestedSize;
        if (requestedSize) {
          url.searchParams.set('columns', String(requestedSize.columns));
          url.searchParams.set('rows', String(requestedSize.rows));
        }
        if (this.#entryClaimPending && this.#connectionAttempt === 1) url.searchParams.set('active', '1');
        return url;
      },
      {
        onDiagnostic: (detail) => window.dispatchEvent(new CustomEvent('vampire:terminal-connection', { detail })),
        onOpen: () => {
          if (this.#destroyed) return;
          this.#reconnectExhausted = false;
          this.#outputSequence.reset();
          this.#sharedGeometry = undefined;
          this.#hideTerminalDisplay();
          this.#updateState({
            connected: true,
            controlSizeMismatch: false,
            controlsTerminal: undefined,
            error: '',
            inputReady: false,
            openingStage: 'attaching',
            screenReady: false,
          });
          this.#scheduleResize();
        },
        onMessage: (message, context) => {
          if (this.#destroyed) return;
          if (message.type === 'geometry') {
            this.#geometryConnectionId = context.id;
            const controlChanged =
              this.#state.controlsTerminal !== undefined &&
              message.active !== undefined &&
              this.#state.controlsTerminal !== message.active;
            if (message.active !== undefined) this.#updateState({ controlsTerminal: message.active });
            this.#applyGeometry({ columns: message.columns, rows: message.rows }, message.active);
            if (controlChanged) this.#controlRefreshPending = true;
            if (this.#controlRefreshPending) this.#scheduleControlRefresh();
          } else if (message.type === 'snapshot') {
            this.#outputSequence.establish(context.id, message.throughSequence);
            if (!this.#initialSnapshotReceived) {
              this.#initialSnapshotReceived = true;
              this.#updateState({ openingVisible: true, openingStage: 'restoring' });
            }
            this.#beginSnapshot(message.data, context, message.history, message.snapshotId);
          } else if (message.type === 'screen-ready') {
            this.#connection?.markReady(context);
            if (this.#geometryConnectionId !== context.id) {
              // A pre-geometry server ignores the protocol query. Keep its compatibility
              // client-side fit behavior until this page reconnects to a newer server.
              this.#scheduleResize();
            }
            this.#updateState({ inputReady: true, reconnecting: false });
            if (this.#initialFocusPending) {
              this.#initialFocusPending = false;
              this.#scheduleInitialFocus();
            }
            const snapshot = this.#pendingSnapshot;
            if (snapshot?.context.id === context.id) {
              snapshot.serverReady = true;
              this.#finishSnapshotIfReady(snapshot);
            }
          } else if (message.type === 'output') {
            if (!this.#acceptOutputSequence(message, context)) return;
            if (message.activity && message.activityAt !== null) this.#markOutputActivity(message.activityAt);
            if (message.data) this.#historyMayHaveGrown = true;
            this.#writeTerminalOutput(message.data);
          } else if (message.type === 'submission-result') {
            const timer = this.#submissionTimers.get(message.requestId);
            if (timer) clearTimeout(timer);
            this.#submissionTimers.delete(message.requestId);
            this.#options.onSubmissionResult?.(message);
          } else if (message.type === 'repository-status') {
            this.#options.onRepositoryStatus(message.changeCount, message.worktreeCount, message.branch);
          } else if (message.type === 'error') {
            this.#updateState({ error: message.message });
          }
        },
        onDisconnect: (event, retrying) => {
          this.#reconnectExhausted = false;
          this.#markSubmissionsUncertain();
          this.#outputSequence.reset();
          this.#setOutputActive(false);
          this.#resetHistoryLoading();
          this.#invalidatePendingTerminalStream();
          this.#hideTerminalDisplay();
          if (this.#destroyed) return;
          if (retrying) {
            this.#updateState({
              connected: false,
              controlsTerminal: undefined,
              error: '',
              inputReady: false,
              screenReady: false,
            });
            return;
          }
          this.#updateState({
            connected: false,
            controlsTerminal: undefined,
            inputReady: false,
            reconnecting: false,
            screenReady: false,
            error:
              event.code === 1008 && ['authentication expired', 'authentication revoked'].includes(event.reason)
                ? 'This terminal workspace is no longer authorized.'
                : 'Terminal connection closed.',
          });
        },
        onRetrying: () => this.#updateState({ reconnecting: true }),
        onReconnectExhausted: () => {
          this.#reconnectExhausted = true;
          this.#updateState({
            reconnecting: false,
            error: 'Could not reconnect to terminal.',
          });
        },
        onProtocolError: () => this.#updateState({ error: 'The terminal sent an unreadable response.' }),
      },
    );
    this.#connection.setRetryEnabled(document.visibilityState === 'visible');
    this.#connection.start();
    this.#resizeObserver = new ResizeObserver(() => this.#scheduleResize());
    this.#resizeObserver.observe(this.#options.element);
  }

  #requestHistory({
    revealLines = 0,
    toTop = false,
    loadAll = false,
  }: {
    revealLines?: number;
    toTop?: boolean;
    loadAll?: boolean;
  } = {}): boolean {
    const terminal = this.#terminal;
    const connection = this.#connection;
    if (
      !terminal ||
      !connection ||
      !this.#state.connected ||
      !this.#state.screenReady ||
      !this.#historyEnabled ||
      this.#historyLoadPending ||
      (this.#historyLoaded >= this.#historyAvailable && !this.#historyMayHaveGrown) ||
      this.#historyLoaded >= this.#historyMaximum ||
      terminal.buffer.active.type !== 'normal'
    )
      return false;
    const buffer = terminal.buffer.active;
    // xterm has no supported API for prepending rows. Request a cumulative
    // snapshot and rebuild it while retaining the user's visual anchor.
    const representedLines = Math.max(this.#historyLoaded, buffer.baseY);
    const lines = loadAll
      ? this.#historyMaximum
      : Math.min(this.#historyMaximum, representedLines + this.#historyChunkLines);
    if (lines <= 0) return false;
    this.#historyAnchor = {
      baseY: buffer.baseY,
      viewportY: buffer.viewportY,
      revealLines,
      toTop,
    };
    this.#historyLoadPending = true;
    if (connection.send({ type: 'load-history', lines })) return true;
    this.#historyAnchor = undefined;
    this.#historyLoadPending = false;
    return false;
  }

  #restoreHistorySnapshot(history: TerminalHistoryState | undefined): void {
    const terminal = this.#terminal;
    const anchor = this.#historyAnchor;
    this.#historyEnabled = Boolean(history);
    this.#historyLoaded = history?.loaded ?? 0;
    this.#historyAvailable = history?.available ?? 0;
    if (terminal && anchor && terminal.buffer.active.type === 'normal') {
      const buffer = terminal.buffer.active;
      const addedLines = Math.max(0, buffer.baseY - anchor.baseY);
      const target = anchor.toTop
        ? 0
        : Math.max(0, Math.min(buffer.baseY, anchor.viewportY + addedLines + anchor.revealLines));
      terminal.scrollToLine(target);
    }
    this.#historyAnchor = undefined;
    this.#historyLoadPending = false;
  }

  #resetHistoryLoading(): void {
    this.#historyMayHaveGrown = false;
    this.#historyAnchor = undefined;
    this.#historyAvailable = 0;
    this.#historyEnabled = false;
    this.#historyLoadPending = false;
    this.#historyLoaded = 0;
  }

  #acceptOutputSequence(
    message: Extract<TerminalServerMessage, { type: 'output' }>,
    context: TerminalConnectionContext,
  ): boolean {
    if (this.#outputSequence.accept(context.id, message)) return true;
    this.#handleOutputSequenceGap(context);
    return false;
  }

  #handleOutputSequenceGap(context: TerminalConnectionContext): void {
    if (!context.isCurrent()) return;
    this.#outputSequence.reset();
    this.#resetHistoryLoading();
    this.#invalidatePendingTerminalStream();
    this.#hideTerminalDisplay();
    this.#updateState({
      connected: false,
      controlsTerminal: undefined,
      error: '',
      reconnecting: true,
      screenReady: false,
    });
    this.#markSubmissionsUncertain();
    this.#connection?.restart('terminal output sequence gap');
  }

  #beginSnapshot(
    data: string,
    context: TerminalConnectionContext,
    history?: TerminalHistoryState,
    snapshotId?: number,
  ): void {
    if (!context.isCurrent()) return;
    // Same-sized history snapshots may contain newer output; apply their contents and fence together.
    this.#historyMayHaveGrown = false;
    this.#cancelScheduledOutput();
    this.#pendingOutput = '';
    const snapshot: PendingTerminalSnapshot = {
      context,
      data,
      generation: ++this.#snapshotGeneration,
      history,
      rendered: false,
      serverReady: false,
      ...(snapshotId === undefined ? {} : { snapshotId }),
      written: false,
    };
    this.#pendingSnapshot = snapshot;
    // xterm parses a large snapshot asynchronously. Hide intermediate parser
    // frames until the complete snapshot has been parsed and painted.
    this.#hideTerminalDisplay();
    this.#updateState({ screenReady: false });
    this.#startPendingSnapshot();
  }

  #invalidatePendingTerminalStream(): void {
    this.#snapshotGeneration += 1;
    this.#pendingSnapshot = undefined;
    this.#cancelScheduledOutput();
    this.#pendingOutput = '';
  }

  #startPendingSnapshot(): void {
    const terminal = this.#terminal;
    const snapshot = this.#pendingSnapshot;
    if (!terminal || !snapshot || this.#activeTerminalWrite || !snapshot.context.isCurrent()) return;
    this.#activeTerminalWrite = { kind: 'snapshot', generation: snapshot.generation };
    terminal.reset();
    terminal.write(snapshot.data, () => this.#completeSnapshotWrite(snapshot.generation));
  }

  #completeSnapshotWrite(generation: number): void {
    const activeWrite = this.#activeTerminalWrite;
    if (!activeWrite || activeWrite.kind !== 'snapshot' || activeWrite.generation !== generation) return;
    this.#activeTerminalWrite = undefined;
    const snapshot = this.#pendingSnapshot;
    if (!snapshot || snapshot.generation !== generation || !snapshot.context.isCurrent()) {
      this.#startPendingSnapshot();
      return;
    }
    snapshot.written = true;
    this.#restoreHistorySnapshot(snapshot.history);
    this.#refreshTerminalDisplay();
    this.#finishSnapshotIfReady(snapshot);
  }

  #finishSnapshotIfReady(snapshot: PendingTerminalSnapshot): void {
    if (
      this.#pendingSnapshot !== snapshot ||
      !snapshot.written ||
      !snapshot.rendered ||
      !snapshot.serverReady ||
      !snapshot.context.isCurrent()
    )
      return;
    this.#pendingSnapshot = undefined;
    this.#updateState({ screenReady: true, openingVisible: false, reconnecting: false });
    this.#entryClaimPending = false;
    if (this.#openingDelay) clearTimeout(this.#openingDelay);
    this.#openingDelay = undefined;
    this.#terminal?.element?.style.removeProperty('opacity');

    const pendingOutput = this.#pendingOutput;
    this.#pendingOutput = '';
    if (pendingOutput) this.#startTerminalOutputWrite(pendingOutput);
    snapshot.context.send({
      type: 'snapshot-ready',
      ...(snapshot.snapshotId === undefined ? {} : { snapshotId: snapshot.snapshotId }),
    });
  }

  #writeTerminalOutput(data: string): void {
    if (!data || this.#destroyed || !this.#terminal) return;
    // A single tmux redraw can arrive as several control-mode records. Keep
    // those parser writes together so xterm does not render each transport
    // fragment as a separate intermediate frame.
    this.#pendingOutput += data;
    this.#scheduleOutputFlush();
  }

  #startTerminalOutputWrite(data: string): void {
    const terminal = this.#terminal;
    if (!terminal || !data || this.#destroyed) return;
    this.#activeTerminalWrite = { kind: 'output' };
    terminal.write(data, () => {
      const activeWrite = this.#activeTerminalWrite;
      if (!activeWrite || activeWrite.kind !== 'output') return;
      this.#activeTerminalWrite = undefined;
      if (this.#destroyed) return;
      if (this.#pendingSnapshot) {
        this.#startPendingSnapshot();
        return;
      }
      if (this.#pendingOutput) this.#scheduleOutputFlush();
    });
  }

  #scheduleOutputFlush(): void {
    if (this.#destroyed || this.#pendingSnapshot || this.#activeTerminalWrite || this.#outputFrame !== undefined) {
      return;
    }

    this.#outputFrame = requestAnimationFrame(() => {
      this.#outputFrame = undefined;
      if (this.#destroyed || this.#pendingSnapshot || this.#activeTerminalWrite) return;

      const pending = this.#pendingOutput;
      this.#pendingOutput = '';
      if (pending) this.#startTerminalOutputWrite(pending);
    });
  }

  #cancelScheduledOutput(): void {
    if (this.#outputFrame !== undefined) {
      cancelAnimationFrame(this.#outputFrame);
      this.#outputFrame = undefined;
    }
  }

  #hideTerminalDisplay(): void {
    this.#terminal?.element?.style.setProperty('opacity', '0');
  }

  #markInputActivity(): void {
    const now = Date.now();
    if (now - this.#inputNoticeAt < INPUT_ACTIVITY_NOTICE_MS) return;
    this.#inputNoticeAt = now;
    this.#options.onInputActivity(this.#options.workspaceId, now);
  }

  #setOutputActive(active: boolean, timestamp?: number): void {
    if (
      active &&
      timestamp !== undefined &&
      (!this.#outputActive || timestamp - this.#lastOutputActivityNotice >= OUTPUT_ACTIVITY_NOTICE_MS)
    ) {
      this.#lastOutputActivityNotice = timestamp;
      this.#options.onOutputActivity(this.#options.workspaceId, true, timestamp);
    }
    if (this.#outputActive === active) return;
    this.#outputActive = active;
    if (!active) {
      this.#lastOutputActivityNotice = 0;
      this.#options.onOutputActivity(this.#options.workspaceId, false);
    }
  }

  #markOutputActivity(timestamp: number): void {
    this.#setOutputActive(true, timestamp);
    if (this.#outputActivityTimer) clearTimeout(this.#outputActivityTimer);
    this.#outputActivityTimer = setTimeout(() => this.#setOutputActive(false), OUTPUT_ACTIVE_MS);
  }

  #applyGeometry(geometry: TerminalSize, controlsTerminal?: boolean): void {
    this.#sharedGeometry = geometry;
    const terminal = this.#terminal;
    if (controlsTerminal === true) {
      const fitAddon = this.#fit;
      if (fitAddon)
        this.#requestedSize = fitTerminalToVisibleArea(fitAddon, (columns, rows) => terminal?.resize(columns, rows));
      this.#updateControlSizeMismatch();
      const requested = this.#requestedSize;
      if (requested && (requested.columns !== geometry.columns || requested.rows !== geometry.rows)) {
        // A delayed geometry notification must not roll an active xterm back to
        // an obsolete grid. Publish the current fit again instead.
        this.#sentSizeConnection = 0;
        this.#scheduleResize();
      }
      return;
    }
    this.#updateControlSizeMismatch();
    if (!terminal || (terminal.cols === geometry.columns && terminal.rows === geometry.rows)) return;
    terminal.resize(geometry.columns, geometry.rows);
  }

  #scheduleControlRefresh(): void {
    if (this.#screenRefreshTimer) clearTimeout(this.#screenRefreshTimer);
    this.#screenRefreshTimer = setTimeout(() => {
      this.#screenRefreshTimer = undefined;
      if (this.#destroyed || !this.#controlRefreshPending) return;
      this.#controlRefreshPending = false;
      this.#connection?.send({ type: 'refresh-screen' });
    }, 160);
  }

  #sendSize(): void {
    if (document.visibilityState !== 'visible') return;
    const fitAddon = this.#fit;
    if (!fitAddon) return;
    const connection = this.#connection;
    // The active browser owns the local xterm grid and publishes that fit to
    // tmux. A passive browser only measures its preferred size; it must retain
    // the shared tmux geometry to parse the same raw terminal stream correctly.
    const dimensions =
      this.#state.controlsTerminal === false
        ? terminalSizeForVisibleArea(fitAddon)
        : fitTerminalToVisibleArea(fitAddon, (columns, rows) => this.#terminal?.resize(columns, rows));
    if (!dimensions) return;
    this.#requestedSize = dimensions;
    this.#updateControlSizeMismatch();
    const key = `${dimensions.columns}x${dimensions.rows}`;
    if (!connection || (key === this.#lastSentSize && this.#sentSizeConnection === connection.connectionId)) return;
    if (connection.send({ type: 'resize', ...dimensions })) {
      this.#lastSentSize = key;
      this.#sentSizeConnection = connection.connectionId;
    }
  }

  #scheduleResize(): void {
    if (this.#resizeFrame !== undefined) return;
    this.#resizeFrame = requestAnimationFrame(() => {
      this.#resizeFrame = undefined;
      if (this.#destroyed) return;
      // xterm recommends debouncing resize calls because each one can cause a
      // PTY SIGWINCH and another geometry echo while the CSS grid is settling.
      if (this.#resizeTimer !== undefined) clearTimeout(this.#resizeTimer);
      this.#resizeTimer = setTimeout(() => {
        this.#resizeTimer = undefined;
        if (!this.#destroyed) this.#sendSize();
      }, TERMINAL_RESIZE_DEBOUNCE_MS);
    });
  }

  #cancelScheduledResize(): void {
    if (this.#resizeFrame !== undefined) cancelAnimationFrame(this.#resizeFrame);
    this.#resizeFrame = undefined;
    if (this.#resizeTimer !== undefined) clearTimeout(this.#resizeTimer);
    this.#resizeTimer = undefined;
  }

  #refreshTerminalDisplay(clearTextureAtlas = false): void {
    const terminal = this.#terminal;
    if (this.#destroyed || !terminal || terminal.rows < 1) return;
    if (clearTextureAtlas) terminal.clearTextureAtlas();
    terminal.refresh(0, terminal.rows - 1);
  }

  #handleTerminalWheel = (event: WheelEvent): void => {
    const terminal = this.#terminal;
    if (
      !terminal ||
      terminal.buffer.active.type !== 'normal' ||
      terminal.modes.mouseTrackingMode !== 'none' ||
      event.deltaY >= 0 ||
      terminal.buffer.active.viewportY !== 0
    )
      return;
    const screenHeight = terminal.element?.querySelector<HTMLElement>('.xterm-screen')?.getBoundingClientRect().height;
    const rowHeight = screenHeight && terminal.rows > 0 ? screenHeight / terminal.rows : 16;
    const requestedLines =
      event.deltaMode === 2
        ? Math.ceil(Math.abs(event.deltaY) * terminal.rows)
        : event.deltaMode === 1
          ? Math.ceil(Math.abs(event.deltaY))
          : Math.ceil(Math.abs(event.deltaY) / rowHeight);
    this.#requestHistory({ revealLines: -Math.min(terminal.rows, Math.max(1, requestedLines)) });
  };

  #handleTerminalTouchScroll(lines: number): boolean {
    const terminal = this.#terminal;
    if (!terminal) return true;
    if (terminal.buffer.active.type === 'normal' && terminal.modes.mouseTrackingMode === 'none') {
      if (lines < 0 && terminal.buffer.active.viewportY === 0) {
        this.#requestHistory({ revealLines: lines });
      }
      return false;
    }

    // scrollLines only navigates xterm scrollback. Full-screen TUIs and apps
    // with mouse tracking instead expect wheel input, so route the same touch
    // gesture through xterm's native wheel protocol at the screen center.
    const screen = terminal.element?.querySelector<HTMLElement>('.xterm-screen');
    const bounds = screen?.getBoundingClientRect();
    const rowHeight = bounds && terminal.rows > 0 ? bounds.height / terminal.rows : 16;
    terminal.element?.dispatchEvent(
      new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        clientX: bounds ? bounds.left + bounds.width / 2 : 0,
        clientY: bounds ? bounds.top + bounds.height / 2 : 0,
        deltaMode: WheelEvent.DOM_DELTA_PIXEL,
        deltaY: lines * rowHeight,
        view: window,
      }),
    );
    return true;
  }

  #handleVisibilityChange = (): void => {
    const visible = document.visibilityState === 'visible';
    if (!visible) {
      this.#connection?.setRetryEnabled(false);
      this.#cancelScheduledResize();
      return;
    }
    this.#sendSize();
    this.#connection?.setRetryEnabled(true);
    this.#recoverConnection();
    this.#scheduleResize();
    this.#refreshTerminalDisplay(true);
  };

  #handleOnline = (): void => {
    if (document.visibilityState === 'visible') this.#recoverConnection();
  };

  #recoverConnection(): void {
    // A new foreground/network opportunity gets a fresh retry budget. Ordinary
    // focus events during an ongoing attempt must not extend that budget.
    if (this.#reconnectExhausted) this.reconnect();
    else if (this.#state.reconnecting) this.#connection?.retryNow(false);
  }

  #handleThemeChange = (): void => {
    if (!this.#terminal) return;
    this.#applyTheme();
    this.#refreshTerminalDisplay(true);
  };

  #applyTheme(): void {
    if (!this.#terminal) return;
    this.#terminal.options.theme = this.#options.getTheme();
  }

  #updateControlSizeMismatch(): void {
    const preferred = this.#requestedSize;
    const shared = this.#sharedGeometry;
    this.#updateState({
      controlSizeMismatch:
        this.#state.controlsTerminal === false &&
        preferred !== undefined &&
        shared !== undefined &&
        (preferred.columns !== shared.columns || preferred.rows !== shared.rows),
    });
  }

  #handleTerminalData(data: string): void {
    const reports = parseTerminalColorReports(data);
    if (!reports) {
      this.#options.onTerminalInput();
      this.send(data);
      return;
    }
    const theme = this.#options.getTheme();
    for (const report of reports) {
      // xterm can emit its previous palette for one frame after options.theme
      // changes. The app theme is authoritative for OSC color replies.
      this.#sendTerminalColor(report.slot, terminalThemeColor(report.slot, theme, report.color));
    }
  }

  #sendTerminalColor(slot: TerminalColorSlot, color: string): void {
    this.#connection?.send({ type: 'terminal-color', slot, color });
  }

  #updateState(changes: Partial<TerminalRuntimeState>): void {
    let changed = false;
    for (const [key, value] of Object.entries(changes) as Array<
      [keyof TerminalRuntimeState, TerminalRuntimeState[keyof TerminalRuntimeState]]
    >) {
      if (this.#state[key] === value) continue;
      (this.#state as Record<keyof TerminalRuntimeState, TerminalRuntimeState[keyof TerminalRuntimeState]>)[key] =
        value;
      changed = true;
    }
    if (changed) this.#options.onStateChange({ ...this.#state });
  }
}

export function acquireTerminalRuntime(options: TerminalRuntimeOptions): TerminalRuntime {
  return new TerminalRuntime(options);
}

export function releaseTerminalRuntime(runtime: TerminalRuntime): void {
  runtime.dispose();
}
