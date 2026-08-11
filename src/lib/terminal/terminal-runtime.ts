import type { ITheme, Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import { TerminalConnection, type TerminalConnectionContext } from './connection.ts';
import {
	isTerminalRgbColor,
	parseTerminalColorReports,
	terminalThemeColor,
	type TerminalColorSlot
} from './color-report.ts';
import {
	fitTerminalToVisibleArea,
	terminalSizeForVisibleArea,
	type TerminalSize
} from './fit.ts';
import { TERMINAL_PROTOCOL_VERSION, TERMINAL_SCROLLBACK_LINES } from './protocol.ts';
import { TERMINAL_OUTPUT_BACKLOG_CHARACTER_LIMIT, TerminalScreenSync } from './screen-sync.ts';
import { installTerminalTouchScroll } from './touch-scroll.ts';
import { COMPACT_MEDIA_QUERY, isDesktopViewport } from '$lib/ui/layout';

const OPENING_DELAY_MS = 160;
const OUTPUT_ACTIVE_MS = 2_500;
const INPUT_ACTIVITY_NOTICE_MS = 750;
const OUTPUT_ACTIVITY_NOTICE_MS = 500;
const DESKTOP_RESIZE_SETTLE_MS = 80;
const COMPACT_RESIZE_SETTLE_MS = 180;
const TERMINAL_FONT_SIZE_KEY = 'vampire:terminal-font-size';

export type TerminalOpeningStage = 'opening' | 'attaching' | 'restoring';

export interface TerminalRuntimeState {
	connected: boolean;
	controlSizeMismatch: boolean;
	controlsTerminal: boolean | undefined;
	directInputFocused: boolean;
	error: string;
	openingStage: TerminalOpeningStage;
	openingVisible: boolean;
	outputPaused: boolean;
	reconnecting: boolean;
	screenReady: boolean;
}

export interface TerminalRuntimeOptions {
	element: HTMLDivElement;
	sessionId: string;
	terminalId?: string;
	fontSize: number;
	minimumFontSize: number;
	maximumFontSize: number;
	themeChangeEvent: string;
	getFontFamily: () => string;
	getTheme: () => ITheme;
	onFontSizeChange: (size: number) => void;
	onInputActivity: (sessionId: string, timestamp: number) => void;
	onOutputActivity: (sessionId: string, active: boolean, timestamp?: number) => void;
	onRepositoryStatus: (changeCount: number, worktreeCount: number) => void;
	onStateChange: (state: Readonly<TerminalRuntimeState>) => void;
}

interface DeferredTerminalSnapshot {
	context: TerminalConnectionContext;
	data: string;
	output: string;
	screenReady: boolean;
}

export class TerminalRuntime {
	#entryClaimPending = true;
	#composing = false;
	#compositionSettleTimer: ReturnType<typeof setTimeout> | undefined;
	#connection: TerminalConnection | undefined;
	#deferredSnapshot: DeferredTerminalSnapshot | undefined;
	#deferredGeometry: TerminalSize | undefined;
	#destroyed = false;
	#displayRefreshFrame: number | undefined;
	#displayRefreshNeedsAtlasClear = false;
	#displayRefreshPendingComposition = false;
	#fit: FitAddon | undefined;
	#fontSize: number;
	#geometryConnectionId = 0;
	#inputDisposable: { dispose(): void } | undefined;
	#inputNoticeAt = 0;
	#lastOutputActivityNotice = 0;
	#lastSentSize = '';
	#legacyGeometryConnectionId = 0;
	#openingDelay: ReturnType<typeof setTimeout> | undefined;
	#options: TerminalRuntimeOptions;
	#outputActive = false;
	#outputActivityTimer: ReturnType<typeof setTimeout> | undefined;
	#removeInputLifecycle: () => void = () => undefined;
	#removeTouchScroll: () => void = () => undefined;
	#requestedSize: TerminalSize | undefined;
	#resizeFrame: number | undefined;
	#resizeTimer: ReturnType<typeof setTimeout> | undefined;
	#screenSync: TerminalScreenSync | undefined;
	#sentSizeConnection = 0;
	#sharedGeometry: TerminalSize | undefined;
	#started = false;
	#state: TerminalRuntimeState = {
		connected: false,
		controlSizeMismatch: false,
		controlsTerminal: undefined,
		directInputFocused: false,
		error: '',
		openingStage: 'opening',
		openingVisible: false,
		outputPaused: false,
		reconnecting: false,
		screenReady: false
	};
	#terminal: Terminal | undefined;
	#terminalInputFocused = false;
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
		this.#removeTouchScroll = installTerminalTouchScroll(
			this.#options.element,
			() => this.#terminal,
			{
				onTap: () => this.focus()
			}
		);
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

	markComposerFocused(): void {
		this.#updateState({ directInputFocused: false });
	}

	scrollToTop(): void {
		this.#terminal?.scrollToTop();
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
		if (!terminal || !this.#connection?.send({
			type: 'submit',
			data,
			bracketedPaste: terminal.modes.bracketedPasteMode
				&& terminal.options.ignoreBracketedPasteMode !== true
		})) return false;
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
		this.#removeTouchScroll();
		this.#removeInputLifecycle();
		if (this.#outputActivityTimer) clearTimeout(this.#outputActivityTimer);
		if (this.#compositionSettleTimer) clearTimeout(this.#compositionSettleTimer);
		this.#cancelScheduledResize();
		if (this.#displayRefreshFrame !== undefined) cancelAnimationFrame(this.#displayRefreshFrame);
		if (this.#openingDelay) clearTimeout(this.#openingDelay);
		this.#deferredSnapshot = undefined;
		this.#deferredGeometry = undefined;
		this.#setOutputActive(false);
		this.#resizeObserver?.disconnect();
		this.#inputDisposable?.dispose();
		this.#connection?.stop();
		this.#screenSync?.dispose();
		this.#terminal?.dispose();
	}

	async #openTerminal(): Promise<void> {
		const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]);
		if (this.#destroyed) return;
		const desktopInput = isDesktopViewport();
		const compactLayout = window.matchMedia(COMPACT_MEDIA_QUERY).matches;
		this.#touchLayout = window.matchMedia(`${COMPACT_MEDIA_QUERY}, (pointer: coarse)`).matches;
		const scrollback = this.#touchLayout
			? TERMINAL_SCROLLBACK_LINES.reduced
			: TERMINAL_SCROLLBACK_LINES.standard;
		const savedFontSize = Number(window.localStorage.getItem(TERMINAL_FONT_SIZE_KEY));
		this.#fontSize = Number.isFinite(savedFontSize)
			&& savedFontSize >= this.#options.minimumFontSize
			&& savedFontSize <= this.#options.maximumFontSize
			? savedFontSize
			: compactLayout ? 12 : this.#fontSize;
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
			smoothScrollDuration: 0
		});
		this.#terminal = terminal;
		const fitAddon = new FitAddon();
		this.#fit = fitAddon;
		terminal.loadAddon(fitAddon);
		terminal.open(this.#options.element);
		this.#attachInputLifecycle(terminal, desktopInput);

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
			onOverflow: () => this.#pauseOutput()
		});
		terminal.attachCustomKeyEventHandler((event) => {
			if (event.key !== 'Enter' || !event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return true;
			event.preventDefault();
			if (event.type === 'keydown') this.send('\u001b[13;2u');
			return false;
		});
		this.#inputDisposable = terminal.onData((data) => this.#handleTerminalData(data));

		const initialSize = fitTerminalToVisibleArea(fitAddon);
		this.#requestedSize = initialSize;
		const websocketUrl = new URL(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/terminal`);
		websocketUrl.searchParams.set('session', this.#options.sessionId);
		websocketUrl.searchParams.set('history', String(scrollback));
		websocketUrl.searchParams.set('protocol', String(TERMINAL_PROTOCOL_VERSION));
		if (this.#options.terminalId) websocketUrl.searchParams.set('terminal', this.#options.terminalId);
		this.#connection = new TerminalConnection(() => {
			const url = new URL(websocketUrl);
			const requestedSize = this.#requestedSize;
			if (requestedSize) {
				url.searchParams.set('columns', String(requestedSize.columns));
				url.searchParams.set('rows', String(requestedSize.rows));
			}
			if (this.#entryClaimPending) url.searchParams.set('active', '1');
			return url;
		}, {
			onOpen: () => {
				if (this.#destroyed) return;
				this.#sharedGeometry = undefined;
				this.#updateState({
					connected: true,
					controlSizeMismatch: false,
					controlsTerminal: undefined,
					error: '',
					openingStage: 'attaching',
					outputPaused: false
				});
				this.#reportTerminalTheme();
				if (desktopInput && this.#canClaimControl()) {
					requestAnimationFrame(() => {
						if (this.#destroyed) return;
						terminal.focus();
						this.#updateState({ directInputFocused: true });
					});
				}
				this.#scheduleResize(0);
			},
			onMessage: (message, context) => {
				if (this.#destroyed) return;
				if (message.type === 'geometry') {
					this.#geometryConnectionId = context.id;
					if (this.#legacyGeometryConnectionId === context.id) this.#legacyGeometryConnectionId = 0;
					if (message.active !== undefined) this.#updateState({ controlsTerminal: message.active });
					this.#applyGeometry({ columns: message.columns, rows: message.rows });
				} else if (message.type === 'request-terminal-theme') {
					this.#reportTerminalTheme();
				} else if (message.type === 'snapshot') {
					this.#updateState({ openingVisible: true, openingStage: 'restoring' });
					if (this.#composing) {
						this.#deferredSnapshot = {
							context,
							data: message.data,
							output: '',
							screenReady: false
						};
					} else {
						this.#beginSnapshot(message.data, context);
					}
				} else if (message.type === 'screen-ready') {
					this.#connection?.markReady(context);
					if (this.#geometryConnectionId !== context.id) {
						// A pre-geometry server ignores the protocol query. Keep its legacy
						// client-side fit behavior until this page reconnects to a newer server.
						this.#legacyGeometryConnectionId = context.id;
						this.#scheduleResize(0);
					}
					this.#updateState({ reconnecting: false });
					const deferred = this.#deferredSnapshot;
					if (deferred?.context.id === context.id) deferred.screenReady = true;
					else this.#screenSync?.markScreenReady();
				} else if (message.type === 'output') {
					if (message.activity && message.activityAt !== null) this.#markOutputActivity(message.activityAt);
					const deferred = this.#deferredSnapshot;
					if (deferred?.context.id === context.id) this.#bufferDeferredOutput(deferred, message.data);
					else this.#screenSync?.pushOutput(message.data);
				} else if (message.type === 'repository-status') {
					this.#options.onRepositoryStatus(message.changeCount, message.worktreeCount);
				} else if (message.type === 'error') {
					this.#updateState({ error: message.message });
				}
			},
			onDisconnect: (event, retrying) => {
				this.#setOutputActive(false);
				this.#deferredSnapshot = undefined;
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
					error: event.code === 1008 && event.reason === 'authentication expired'
						? 'This terminal session is no longer authorized.'
						: 'Terminal connection closed.'
				});
			},
			onRetrying: () => this.#updateState({ reconnecting: true }),
			onReconnectExhausted: () => this.#updateState({
				reconnecting: false,
				error: 'Could not reconnect to terminal.'
			}),
			onProtocolError: () => this.#updateState({ error: 'The terminal sent an unreadable response.' })
		});
		this.#connection.setRetryEnabled(document.visibilityState === 'visible');
		this.#connection.start();
		this.#resizeObserver = new ResizeObserver(() => this.#scheduleResize());
		this.#resizeObserver.observe(this.#options.element);
	}

	#attachInputLifecycle(terminal: Terminal, desktopInput: boolean): void {
		const textarea = terminal.textarea;
		if (!textarea) return;
		const handleFocus = () => {
			this.#terminalInputFocused = true;
			if (desktopInput) this.#updateState({ directInputFocused: true });
		};
		const handleBlur = () => {
			this.#terminalInputFocused = false;
			this.#updateState({ directInputFocused: false });
			this.#finishComposition();
		};
		const handleCompositionStart = () => {
			this.#composing = true;
			if (this.#compositionSettleTimer) clearTimeout(this.#compositionSettleTimer);
			this.#compositionSettleTimer = undefined;
			this.#cancelScheduledResize();
		};
		const handleCompositionEnd = () => {
			this.#finishComposition();
		};
		textarea.addEventListener('focus', handleFocus);
		textarea.addEventListener('blur', handleBlur);
		textarea.addEventListener('compositionstart', handleCompositionStart);
		textarea.addEventListener('compositionend', handleCompositionEnd);
		this.#removeInputLifecycle = () => {
			textarea.removeEventListener('focus', handleFocus);
			textarea.removeEventListener('blur', handleBlur);
			textarea.removeEventListener('compositionstart', handleCompositionStart);
			textarea.removeEventListener('compositionend', handleCompositionEnd);
		};
	}

	#finishComposition(): void {
		this.#composing = false;
		if (this.#compositionSettleTimer) clearTimeout(this.#compositionSettleTimer);
		this.#compositionSettleTimer = setTimeout(() => {
			this.#compositionSettleTimer = undefined;
			if (this.#destroyed || this.#composing) return;
			if (this.#deferredGeometry) {
				const geometry = this.#deferredGeometry;
				this.#deferredGeometry = undefined;
				this.#applyGeometry(geometry);
			}
			this.#flushDeferredSnapshot();
			if (this.#displayRefreshPendingComposition) {
				this.#displayRefreshPendingComposition = false;
				this.#scheduleDisplayRefresh();
			}
			this.#scheduleResize();
		}, 0);
	}

	#beginSnapshot(data: string, context: TerminalConnectionContext): void {
		if (!context.isCurrent()) return;
		this.#screenSync?.beginSnapshot(data, {
			isCurrent: context.isCurrent,
			acknowledge: () => context.send({ type: 'snapshot-ready' })
		});
	}

	#bufferDeferredOutput(snapshot: DeferredTerminalSnapshot, output: string): void {
		if (snapshot.output.length + output.length > TERMINAL_OUTPUT_BACKLOG_CHARACTER_LIMIT) {
			this.#deferredSnapshot = undefined;
			this.#pauseOutput();
			return;
		}
		snapshot.output += output;
	}

	#flushDeferredSnapshot(): void {
		const snapshot = this.#deferredSnapshot;
		this.#deferredSnapshot = undefined;
		if (!snapshot?.context.isCurrent()) return;
		this.#beginSnapshot(snapshot.data, snapshot.context);
		if (snapshot.output) this.#screenSync?.pushOutput(snapshot.output);
		if (snapshot.screenReady) this.#screenSync?.markScreenReady();
	}

	#markInputActivity(): void {
		const now = Date.now();
		if (now - this.#inputNoticeAt < INPUT_ACTIVITY_NOTICE_MS) return;
		this.#inputNoticeAt = now;
		this.#options.onInputActivity(this.#options.sessionId, now);
	}

	#setOutputActive(active: boolean, timestamp?: number): void {
		if (
			active
			&& timestamp !== undefined
			&& (!this.#outputActive || timestamp - this.#lastOutputActivityNotice >= OUTPUT_ACTIVITY_NOTICE_MS)
		) {
			this.#lastOutputActivityNotice = timestamp;
			this.#options.onOutputActivity(this.#options.sessionId, true, timestamp);
		}
		if (this.#outputActive === active) return;
		this.#outputActive = active;
		if (!active) {
			this.#lastOutputActivityNotice = 0;
			this.#options.onOutputActivity(this.#options.sessionId, false);
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
			reconnecting: false
		});
		this.#deferredSnapshot = undefined;
		this.#setOutputActive(false);
		this.#connection?.stop();
	}

	#applyGeometry(geometry: TerminalSize): void {
		this.#sharedGeometry = geometry;
		this.#updateControlSizeMismatch();
		if (this.#composing) {
			this.#deferredGeometry = geometry;
			return;
		}
		const terminal = this.#terminal;
		if (!terminal || (terminal.cols === geometry.columns && terminal.rows === geometry.rows)) return;
		terminal.resize(geometry.columns, geometry.rows);
		this.#scheduleDisplayRefresh();
	}

	#sendSize(): void {
		if (this.#composing || document.visibilityState !== 'visible') return;
		const fitAddon = this.#fit;
		if (!fitAddon) return;
		const connection = this.#connection;
		const dimensions = connection && this.#legacyGeometryConnectionId === connection.connectionId
			? fitTerminalToVisibleArea(fitAddon)
			: terminalSizeForVisibleArea(fitAddon);
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

	#scheduleResize(delay = this.#resizeSettleDelay()): void {
		this.#cancelScheduledResize();
		if (this.#composing) return;
		this.#resizeTimer = setTimeout(() => {
			this.#resizeTimer = undefined;
			this.#resizeFrame = requestAnimationFrame(() => {
				this.#resizeFrame = undefined;
				if (!this.#destroyed) this.#sendSize();
			});
		}, delay);
	}

	#cancelScheduledResize(): void {
		if (this.#resizeTimer) clearTimeout(this.#resizeTimer);
		if (this.#resizeFrame !== undefined) cancelAnimationFrame(this.#resizeFrame);
		this.#resizeTimer = undefined;
		this.#resizeFrame = undefined;
	}

	#resizeSettleDelay(): number {
		return this.#touchLayout || this.#terminalInputFocused
			? COMPACT_RESIZE_SETTLE_MS
			: DESKTOP_RESIZE_SETTLE_MS;
	}

	#refreshTerminalDisplay(clearTextureAtlas = false): void {
		const terminal = this.#terminal;
		if (this.#destroyed || !terminal || terminal.rows < 1) return;
		if (this.#composing) {
			this.#displayRefreshNeedsAtlasClear ||= clearTextureAtlas;
			this.#displayRefreshPendingComposition = true;
			return;
		}
		if (clearTextureAtlas) terminal.clearTextureAtlas();
		terminal.refresh(0, terminal.rows - 1);
	}

	#scheduleDisplayRefresh(clearTextureAtlas = false): void {
		this.#displayRefreshNeedsAtlasClear ||= clearTextureAtlas;
		if (this.#composing) {
			this.#displayRefreshPendingComposition = true;
			return;
		}
		if (this.#displayRefreshFrame !== undefined) return;
		this.#displayRefreshFrame = requestAnimationFrame(() => {
			this.#displayRefreshFrame = undefined;
			const clear = this.#displayRefreshNeedsAtlasClear;
			this.#displayRefreshNeedsAtlasClear = false;
			this.#refreshTerminalDisplay(clear);
		});
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
		this.#scheduleResize(0);
		this.#scheduleDisplayRefresh(true);
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
		this.#scheduleDisplayRefresh(true);
	};

	#updateControlSizeMismatch(): void {
		const preferred = this.#requestedSize;
		const shared = this.#sharedGeometry;
		this.#updateState({
			controlSizeMismatch: this.#state.controlsTerminal === false
				&& preferred !== undefined
				&& shared !== undefined
				&& (preferred.columns !== shared.columns || preferred.rows !== shared.rows)
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

	#canClaimControl(): boolean {
		return document.visibilityState === 'visible' && document.hasFocus();
	}

	#updateState(changes: Partial<TerminalRuntimeState>): void {
		let changed = false;
		for (const [key, value] of Object.entries(changes) as Array<[
			keyof TerminalRuntimeState,
			TerminalRuntimeState[keyof TerminalRuntimeState]
		]>) {
			if (this.#state[key] === value) continue;
			(this.#state as Record<keyof TerminalRuntimeState, TerminalRuntimeState[keyof TerminalRuntimeState]>)[key] = value;
			changed = true;
		}
		if (changed) this.#options.onStateChange({ ...this.#state });
	}
}
