import type { ITheme, Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import { TerminalConnection, type TerminalConnectionContext } from '../api/connection.ts';
import {
  isTerminalRgbColor,
  parseTerminalColorReports,
  terminalThemeColor,
  type TerminalColorSlot,
} from '~/lib/shared/contracts/terminal-color.ts';
import { fitTerminalToVisibleArea, terminalSizeForVisibleArea, type TerminalSize } from './fit.ts';
import {
  TERMINAL_HISTORY_CHUNK_LINES,
  TERMINAL_PROTOCOL_VERSION,
  TERMINAL_SCROLLBACK_LINES,
  type TerminalHistoryState,
  type TerminalServerMessage,
} from '~/lib/shared/contracts/terminal-protocol.ts';
import { TerminalScreenSync } from './screen-sync.ts';
import { installTerminalTouchScroll } from './touch-scroll.ts';
import { TerminalOutputSequence } from './output-sequence.ts';
import { COMPACT_MEDIA_QUERY, hasFinePointer } from '~/lib/shared/ui/layout';

const OPENING_DELAY_MS = 160;
const OUTPUT_ACTIVE_MS = 2_500;
const INPUT_ACTIVITY_NOTICE_MS = 750;
const OUTPUT_ACTIVITY_NOTICE_MS = 500;
const TERMINAL_FONT_SIZE_KEY = 'vampire:terminal-font-size';

export type TerminalOpeningStage = 'opening' | 'attaching' | 'restoring';

export interface TerminalRuntimeState {
  connected: boolean;
  controlSizeMismatch: boolean;
  controlsTerminal: boolean | undefined;
  error: string;
  openingStage: TerminalOpeningStage;
  openingVisible: boolean;
  outputPaused: boolean;
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
  onInputActivity: (workspaceId: string, timestamp: number) => void;
  onOutputActivity: (workspaceId: string, active: boolean, timestamp?: number) => void;
  onRepositoryStatus: (changeCount: number, worktreeCount: number, branch?: string) => void;
  onStateChange: (state: Readonly<TerminalRuntimeState>) => void;
  onTerminalInteraction: () => void;
  onTerminalTap: () => void;
}

interface TerminalHistoryAnchor {
  baseY: number;
  viewportY: number;
  revealLines: number;
  toTop: boolean;
}

interface TerminalScreenAnchor {
  distanceFromBottom: number;
}

export class TerminalRuntime {
  #entryClaimPending = true;
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
  #historyMaximum: number = TERMINAL_SCROLLBACK_LINES.standard;
  #inputDisposable: { dispose(): void } | undefined;
  #inputNoticeAt = 0;
  #lastOutputActivityNotice = 0;
  #lastSentSize = '';
  #compatibilityGeometryConnectionId = 0;
  #openingDelay: ReturnType<typeof setTimeout> | undefined;
  #options: TerminalRuntimeOptions;
  #outputActive = false;
  #outputActivityTimer: ReturnType<typeof setTimeout> | undefined;
  #removeTouchScroll: () => void = () => undefined;
  #requestedSize: TerminalSize | undefined;
  #resizeFrame: number | undefined;
  #screenSync: TerminalScreenSync | undefined;
  #outputSequence = new TerminalOutputSequence();
  #screenReplacementAnchor: TerminalScreenAnchor | undefined;
  #scrollDisposable: { dispose(): void } | undefined;
  #sentSizeConnection = 0;
  #sharedGeometry: TerminalSize | undefined;
  #started = false;
  #state: TerminalRuntimeState = {
    connected: false,
    controlSizeMismatch: false,
    controlsTerminal: undefined,
    error: '',
    openingStage: 'opening',
    openingVisible: false,
    outputPaused: false,
    reconnecting: false,
    screenReady: false,
  };
  #terminal: Terminal | undefined;
  #touchLayout = false;
  #resizeObserver: ResizeObserver | undefined;

  constructor(options: TerminalRuntimeOptions) {
    this.#options = options;
    this.#fontSize = options.fontSize;
  }

  get connected(): boolean {
    return this.#state.connected;
  }

  start(): void {
    if (this.#started || this.#destroyed) return;
    this.#started = true;
    this.#options.element.lang = navigator.language || 'und';
    this.#openingDelay = setTimeout(() => {
      this.#openingDelay = undefined;
      if (!this.#state.screenReady && !this.#state.error) this.#updateState({ openingVisible: true });
    }, OPENING_DELAY_MS);
    window.addEventListener('focus', this.#handleVisibilityChange);
    window.addEventListener('online', this.#handleOnline);
    window.addEventListener(this.#options.themeChangeEvent, this.#handleThemeChange);
    document.addEventListener('visibilitychange', this.#handleVisibilityChange);
    this.#options.element.addEventListener('wheel', this.#handleTerminalWheel, { passive: true });
    this.#removeTouchScroll = installTerminalTouchScroll(this.#options.element, () => this.#terminal, {
      onScrollAttempt: (lines) => this.#handleTerminalTouchScroll(lines),
      onScrollStart: this.#options.onTerminalInteraction,
      onTap: this.#options.onTerminalTap,
      useNativeInteraction: () => true,
    });
    void this.#openTerminal();
  }

  claimControl(): void {
    this.#sendSize();
    if (!this.#connection?.send({ type: 'activate' })) return;
    this.#reportTerminalTheme();
  }

  focus(): void {
    this.#terminal?.focus();
  }

  shouldPreserveDirectFocus(): boolean {
    const terminal = this.#terminal;
    return Boolean(
      terminal &&
        (terminal.hasSelection() ||
          terminal.buffer.active.type === 'alternate' ||
          terminal.modes.mouseTrackingMode !== 'none')
    );
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

  send(data: string): void {
    if (!this.#connection?.send({ type: 'input', data })) return;
    this.#markInputActivity();
  }

  submit(data: string): boolean {
    const terminal = this.#terminal;
    if (
      !terminal ||
      !this.#connection?.send({
        type: 'submit',
        data,
        bracketedPaste: terminal.modes.bracketedPasteMode && terminal.options.ignoreBracketedPasteMode !== true,
      })
    )
      return false;
    this.#markInputActivity();
    return true;
  }

  setFontSize(size: number): void {
    if (!Number.isFinite(size)) return;
    const next = Math.min(this.#options.maximumFontSize, Math.max(this.#options.minimumFontSize, size));
    this.#fontSize = next;
    window.localStorage.setItem(TERMINAL_FONT_SIZE_KEY, String(next));
    if (!this.#terminal || this.#terminal.options.fontSize === next) return;
    this.#terminal.options.fontSize = next;
    this.#scheduleResize();
  }

  reconnect(): void {
    if (this.#destroyed) return;
    const wasOutputPaused = this.#state.outputPaused;
    this.#updateState({ error: '', outputPaused: false, reconnecting: true });
    if (wasOutputPaused) this.#connection?.start();
    else this.#connection?.retryNow();
  }

  dispose(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    window.removeEventListener('focus', this.#handleVisibilityChange);
    window.removeEventListener('online', this.#handleOnline);
    window.removeEventListener(this.#options.themeChangeEvent, this.#handleThemeChange);
    document.removeEventListener('visibilitychange', this.#handleVisibilityChange);
    this.#options.element.removeEventListener('wheel', this.#handleTerminalWheel);
    this.#removeTouchScroll();
    if (this.#outputActivityTimer) clearTimeout(this.#outputActivityTimer);
    this.#cancelScheduledResize();
    if (this.#openingDelay) clearTimeout(this.#openingDelay);
    this.#setOutputActive(false);
    this.#resizeObserver?.disconnect();
    this.#inputDisposable?.dispose();
    this.#scrollDisposable?.dispose();
    this.#connection?.stop();
    this.#screenSync?.dispose();
    this.#terminal?.dispose();
  }

  async #openTerminal(): Promise<void> {
    const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]);
    if (this.#destroyed) return;
    const compactLayout = window.matchMedia(COMPACT_MEDIA_QUERY).matches;
    const finePointer = hasFinePointer();
    const desktopInput = finePointer;
    this.#touchLayout = !finePointer;
    const scrollback = this.#touchLayout ? TERMINAL_SCROLLBACK_LINES.reduced : TERMINAL_SCROLLBACK_LINES.standard;
    this.#historyMaximum = scrollback;
    this.#historyChunkLines = this.#touchLayout
      ? TERMINAL_HISTORY_CHUNK_LINES.reduced
      : TERMINAL_HISTORY_CHUNK_LINES.standard;
    const savedFontSize = Number(window.localStorage.getItem(TERMINAL_FONT_SIZE_KEY));
    this.#fontSize =
      Number.isFinite(savedFontSize) &&
      savedFontSize >= this.#options.minimumFontSize &&
      savedFontSize <= this.#options.maximumFontSize
        ? savedFontSize
        : compactLayout
          ? 12
          : this.#fontSize;
    this.#options.onFontSizeChange(this.#fontSize);

    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      disableStdin: false,
      fontSize: this.#fontSize,
      lineHeight: 1.2,
      fontFamily: this.#options.getFontFamily(),
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

    this.#screenSync = new TerminalScreenSync({
      reset: () => terminal.reset(),
      write: (data, complete) => terminal.write(data, complete),
      refresh: () => this.#refreshTerminalDisplay(),
      onReadyChange: (ready) => {
        this.#updateState({ screenReady: ready, ...(ready ? { reconnecting: false } : {}) });
        if (!ready) return;
        this.#entryClaimPending = false;
        this.#reportTerminalTheme();
        if (this.#openingDelay) clearTimeout(this.#openingDelay);
        this.#openingDelay = undefined;
      },
      onWriteComplete: () => undefined,
      onScreenReplaced: () => this.#restoreScreenReplacementAnchor(),
      onOverflow: () => this.#pauseOutput(),
    });
    terminal.attachCustomKeyEventHandler((event) => {
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
    websocketUrl.searchParams.set('history-mode', 'lazy');
    websocketUrl.searchParams.set('protocol', String(TERMINAL_PROTOCOL_VERSION));
    if (this.#options.terminalId) websocketUrl.searchParams.set('terminal', this.#options.terminalId);
    this.#connection = new TerminalConnection(
      () => {
        const url = new URL(websocketUrl);
        const requestedSize = this.#requestedSize;
        if (requestedSize) {
          url.searchParams.set('columns', String(requestedSize.columns));
          url.searchParams.set('rows', String(requestedSize.rows));
        }
        if (this.#entryClaimPending) url.searchParams.set('active', '1');
        return url;
      },
      {
        onOpen: () => {
          if (this.#destroyed) return;
          this.#outputSequence.reset();
          this.#sharedGeometry = undefined;
          this.#updateState({
            connected: true,
            controlSizeMismatch: false,
            controlsTerminal: undefined,
            error: '',
            openingStage: 'attaching',
            outputPaused: false,
          });
          this.#reportTerminalTheme();
          if (desktopInput && this.#options.shouldAutoFocus()) {
            requestAnimationFrame(() => {
              if (this.#destroyed) return;
              terminal.focus();
            });
          }
          this.#scheduleResize();
        },
        onMessage: (message, context) => {
          if (this.#destroyed) return;
          if (message.type === 'geometry') {
            this.#geometryConnectionId = context.id;
            if (this.#compatibilityGeometryConnectionId === context.id) this.#compatibilityGeometryConnectionId = 0;
            if (message.active !== undefined) this.#updateState({ controlsTerminal: message.active });
            this.#applyGeometry({ columns: message.columns, rows: message.rows });
          } else if (message.type === 'request-terminal-theme') {
            this.#reportTerminalTheme();
          } else if (message.type === 'snapshot') {
            this.#outputSequence.establish(context.id, message.throughSequence);
            this.#updateState({ openingVisible: true, openingStage: 'restoring' });
            this.#beginSnapshot(message.data, context, message.history, message.snapshotId);
          } else if (message.type === 'screen-ready') {
            this.#connection?.markReady(context);
            if (this.#geometryConnectionId !== context.id) {
              // A pre-geometry server ignores the protocol query. Keep its compatibility
              // client-side fit behavior until this page reconnects to a newer server.
              this.#compatibilityGeometryConnectionId = context.id;
              this.#scheduleResize();
            }
            this.#updateState({ reconnecting: false });
            this.#screenSync?.markScreenReady();
          } else if (message.type === 'output') {
            if (!this.#acceptOutputSequence(message, context)) return;
            if (message.activity && message.activityAt !== null) this.#markOutputActivity(message.activityAt);
            if (message.screenSync) {
              this.#updateHistoryState(message.history);
              if (message.reset) this.#rememberScreenReplacementAnchor();
              this.#screenSync?.replaceScreen(message.data, message.reset);
            } else this.#screenSync?.pushOutput(message.data);
          } else if (message.type === 'repository-status') {
            this.#options.onRepositoryStatus(message.changeCount, message.worktreeCount, message.branch);
          } else if (message.type === 'error') {
            this.#updateState({ error: message.message });
          }
        },
        onDisconnect: (event, retrying) => {
          this.#outputSequence.reset();
          this.#setOutputActive(false);
          this.#screenReplacementAnchor = undefined;
          this.#resetHistoryLoading();
          this.#screenSync?.disconnect();
          if (this.#destroyed) return;
          if (retrying) {
            this.#updateState({ connected: false, controlsTerminal: undefined, error: '' });
            return;
          }
          this.#updateState({
            connected: false,
            controlsTerminal: undefined,
            reconnecting: false,
            error:
              event.code === 1008 && ['authentication expired', 'authentication revoked'].includes(event.reason)
                ? 'This terminal workspace is no longer authorized.'
                : 'Terminal connection closed.',
          });
        },
        onRetrying: () => this.#updateState({ reconnecting: true }),
        onReconnectExhausted: () =>
          this.#updateState({
            reconnecting: false,
            error: 'Could not reconnect to terminal.',
          }),
        onProtocolError: () => this.#updateState({ error: 'The terminal sent an unreadable response.' }),
      }
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
      this.#historyLoaded >= this.#historyAvailable ||
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

  #updateHistoryState(history: TerminalHistoryState | undefined): void {
    if (!history) return;
    this.#historyEnabled = true;
    this.#historyLoaded = history.loaded;
    this.#historyAvailable = history.available;
  }

  #resetHistoryLoading(): void {
    this.#historyAnchor = undefined;
    this.#historyAvailable = 0;
    this.#historyEnabled = false;
    this.#historyLoadPending = false;
    this.#historyLoaded = 0;
  }

  #acceptOutputSequence(
    message: Extract<TerminalServerMessage, { type: 'output' }>,
    context: TerminalConnectionContext
  ): boolean {
    if (this.#outputSequence.accept(context.id, message)) return true;
    this.#handleOutputSequenceGap(context);
    return false;
  }

  #handleOutputSequenceGap(context: TerminalConnectionContext): void {
    if (!context.isCurrent()) return;
    this.#outputSequence.reset();
    this.#resetHistoryLoading();
    this.#screenSync?.disconnect();
    this.#updateState({ connected: false, controlsTerminal: undefined, error: '', reconnecting: true });
    this.#connection?.restart('terminal output sequence gap');
  }

  #beginSnapshot(
    data: string,
    context: TerminalConnectionContext,
    history?: TerminalHistoryState,
    snapshotId?: number
  ): void {
    if (!context.isCurrent()) return;
    this.#screenReplacementAnchor = undefined;
    const anchor = this.#historyAnchor;
    const buffer = this.#terminal?.buffer.active;
    if (
      history &&
      this.#historyLoadPending &&
      anchor &&
      buffer?.type === 'normal' &&
      history.loaded <= this.#historyLoaded
    ) {
      this.#historyEnabled = true;
      this.#historyLoaded = history.loaded;
      this.#historyAvailable = history.available;
      if (anchor.toTop) this.#terminal?.scrollToTop();
      this.#historyAnchor = undefined;
      this.#historyLoadPending = false;
      context.send({ type: 'snapshot-ready', ...(snapshotId === undefined ? {} : { snapshotId }) });
      return;
    }
    this.#screenSync?.beginSnapshot(data, {
      isCurrent: context.isCurrent,
      acknowledge: () => context.send({ type: 'snapshot-ready', ...(snapshotId === undefined ? {} : { snapshotId }) }),
      onRestored: () => this.#restoreHistorySnapshot(history),
    });
  }

  #markInputActivity(): void {
    const now = Date.now();
    if (now - this.#inputNoticeAt < INPUT_ACTIVITY_NOTICE_MS) return;
    this.#inputNoticeAt = now;
    this.#options.onInputActivity(this.#options.workspaceId, now);
  }

  #rememberScreenReplacementAnchor(): void {
    if (this.#screenReplacementAnchor) return;
    const buffer = this.#terminal?.buffer.active;
    if (!buffer || buffer.type !== 'normal') return;
    this.#screenReplacementAnchor = { distanceFromBottom: buffer.baseY - buffer.viewportY };
  }

  #restoreScreenReplacementAnchor(): void {
    const anchor = this.#screenReplacementAnchor;
    this.#screenReplacementAnchor = undefined;
    const terminal = this.#terminal;
    const buffer = terminal?.buffer.active;
    if (!anchor || !terminal || !buffer || buffer.type !== 'normal') return;
    terminal.scrollToLine(Math.max(0, buffer.baseY - anchor.distanceFromBottom));
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

  #pauseOutput(): void {
    if (this.#destroyed || this.#state.outputPaused) return;
    this.#updateState({
      connected: false,
      error: 'Live output was paused to keep this browser responsive. Resume when the command has settled.',
      outputPaused: true,
      reconnecting: false,
    });
    this.#setOutputActive(false);
    this.#connection?.stop();
  }

  #applyGeometry(geometry: TerminalSize): void {
    this.#sharedGeometry = geometry;
    this.#updateControlSizeMismatch();
    const terminal = this.#terminal;
    if (!terminal || (terminal.cols === geometry.columns && terminal.rows === geometry.rows)) return;
    terminal.resize(geometry.columns, geometry.rows);
  }

  #sendSize(): void {
    if (document.visibilityState !== 'visible') return;
    const fitAddon = this.#fit;
    if (!fitAddon) return;
    const connection = this.#connection;
    const proposed = terminalSizeForVisibleArea(fitAddon);
    if (!proposed) return;
    const dimensions =
      connection && this.#compatibilityGeometryConnectionId === connection.connectionId
        ? fitTerminalToVisibleArea(fitAddon, (columns, rows) => {
            const terminal = this.#terminal;
            if (terminal) terminal.resize(columns, rows);
          })
        : proposed;
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
      if (!this.#destroyed) this.#sendSize();
    });
  }

  #cancelScheduledResize(): void {
    if (this.#resizeFrame !== undefined) cancelAnimationFrame(this.#resizeFrame);
    this.#resizeFrame = undefined;
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
      })
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
    if (this.#state.reconnecting) this.#connection?.retryNow(false);
    this.#scheduleResize();
    this.#refreshTerminalDisplay(true);
  };

  #handleOnline = (): void => {
    if (document.visibilityState === 'visible' && this.#state.reconnecting) {
      this.#connection?.retryNow(false);
    }
  };

  #handleThemeChange = (): void => {
    if (!this.#terminal) return;
    this.#terminal.options.theme = this.#options.getTheme();
    // The server accepts color reports only from the current controller. Theme
    // changes on another device must never take terminal ownership by themselves.
    this.#reportTerminalTheme();
    this.#refreshTerminalDisplay(true);
  };

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

  #reportTerminalTheme(): void {
    const theme = this.#options.getTheme();
    if (isTerminalRgbColor(theme.foreground)) this.#sendTerminalColor(10, theme.foreground);
    if (isTerminalRgbColor(theme.background)) this.#sendTerminalColor(11, theme.background);
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
