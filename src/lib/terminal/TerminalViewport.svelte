<script lang="ts">
	import { onMount, untrack, type Snippet } from 'svelte';
	import TerminalInputDock from './TerminalInputDock.svelte';
	import ShellOpening from './ShellOpening.svelte';
	import { TerminalConnection } from './connection.ts';
	import { TerminalImagePasteState } from './image-paste-state.svelte';
	import { TerminalScreenSync } from './screen-sync.ts';
	import { installTerminalTouchScroll } from './touch-scroll';
	import { terminalFontFamily, terminalTheme, THEME_CHANGE_EVENT } from '$lib/theme/theme.svelte';
	import { COMPACT_MEDIA_QUERY, isDesktopViewport } from '$lib/ui/layout';
	import { parseWorkspaceEntryDrag, WORKSPACE_ENTRY_DRAG_TYPE, workspaceEntryDragText } from '$lib/workspace-entry-drag.ts';
	import '@xterm/xterm/css/xterm.css';

	let {
		sessionId,
		terminalId,
		onInputActivity = () => undefined,
		onOutputActivity = () => undefined,
		onRepositoryStatus = () => undefined,
		fontSize = $bindable(14),
		minimumFontSize = 10,
		maximumFontSize = 22,
		children
	}: {
		sessionId: string;
		terminalId?: string;
		onInputActivity?: (sessionId: string, timestamp: number) => void;
		onOutputActivity?: (sessionId: string, active: boolean, timestamp?: number) => void;
		onRepositoryStatus?: (changeCount: number, worktreeCount: number) => void;
		fontSize?: number;
		minimumFontSize?: number;
		maximumFontSize?: number;
		children?: Snippet;
	} = $props();

	let terminalElement: HTMLDivElement;
	let terminalError = $state('');
	let connected = $state(false);
	let terminalReconnecting = $state(false);
	let outputActive = $state(false);
	let screenReady = $state(false);
	let openingVisible = $state(false);
	let openingStage = $state<'opening' | 'attaching' | 'restoring'>('opening');
	let directInputFocused = $state(false);
	let terminalDropActive = $state(false);
	let sendTerminalInput: (data: string) => void = () => undefined;
	let scrollTerminalToTop: () => void = () => undefined;
	let scrollTerminalToBottom: () => void = () => undefined;
	let activateTerminal: () => void = () => undefined;
	let focusTerminal: () => void = () => undefined;
	let applyTerminalFontSize = $state<(size: number) => void>(() => undefined);
	let reconnectTerminal = $state<() => void>(() => undefined);
	const imagePaste = new TerminalImagePasteState(
		untrack(() => sessionId),
		untrack(() => terminalId),
		() => connected
	);

	function changeTerminalFontSize(delta: number) {
		fontSize = Math.min(maximumFontSize, Math.max(minimumFontSize, fontSize + delta));
	}

	function handleTerminalPointerDown(event: PointerEvent) {
		activateTerminal();
		if (event.pointerType === 'touch') return;
		focusTerminal();
		if (isDesktopViewport()) directInputFocused = true;
	}

	function hasWorkspaceEntry(event: DragEvent): boolean {
		return Array.from(event.dataTransfer?.types ?? []).includes(WORKSPACE_ENTRY_DRAG_TYPE);
	}

	function handleTerminalDragOver(event: DragEvent) {
		if (!connected || !event.dataTransfer || !hasWorkspaceEntry(event)) return;
		event.preventDefault();
		event.dataTransfer.dropEffect = 'copy';
		terminalDropActive = true;
	}

	function handleTerminalDragLeave() {
		terminalDropActive = false;
	}

	function handleTerminalDrop(event: DragEvent) {
		terminalDropActive = false;
		if (!connected) return;
		const raw = event.dataTransfer?.getData(WORKSPACE_ENTRY_DRAG_TYPE);
		const entry = raw ? parseWorkspaceEntryDrag(raw) : undefined;
		if (!entry) return;
		event.preventDefault();
		focusTerminal();
		sendTerminalInput(workspaceEntryDragText(entry));
	}

	const handleClipboardPaste = (event: ClipboardEvent) => {
		void imagePaste.handleClipboardPaste(event);
	};

	$effect(() => {
		applyTerminalFontSize(fontSize);
	});

	onMount(() => {
		let destroyed = false;
		let connection: TerminalConnection | undefined;
		let screenSync: TerminalScreenSync | undefined;
		let terminal: import('@xterm/xterm').Terminal | undefined;
		let fit: import('@xterm/addon-fit').FitAddon | undefined;
		let observer: ResizeObserver | undefined;
		let inputDisposable: { dispose(): void } | undefined;
		let outputActivityTimer: ReturnType<typeof setTimeout> | undefined;
		let resizeTimer: ReturnType<typeof setTimeout> | undefined;
		let resizeFrame: number | undefined;
		let displayRecoveryTimer: ReturnType<typeof setTimeout> | undefined;
		let displayRecoveryFrame: number | undefined;
		let displayRecoveryNeedsAtlasClear = false;
		let openingDelay: ReturnType<typeof setTimeout> | undefined;
		let lastInputNotice = 0;
		let lastActivationNotice = 0;
		let lastSentSize = '';
		let sentSizeConnection = 0;
		let removeTouchScroll: () => void = () => undefined;

		const setOutputActive = (active: boolean, timestamp?: number) => {
			if (active && timestamp !== undefined) onOutputActivity(sessionId, true, timestamp);
			if (outputActive === active) return;
			outputActive = active;
			if (!active) onOutputActivity(sessionId, false);
		};

		const markOutputActivity = (timestamp: number) => {
			setOutputActive(true, timestamp);
			if (outputActivityTimer) clearTimeout(outputActivityTimer);
			outputActivityTimer = setTimeout(() => setOutputActive(false), 2_500);
		};

		const refreshTerminalDisplay = (clearTextureAtlas = false) => {
			if (destroyed || !terminal || terminal.rows < 1) return;
			if (clearTextureAtlas) terminal.clearTextureAtlas();
			terminal.refresh(0, terminal.rows - 1);
		};

		const scheduleDisplayRecovery = (delay = 0, clearTextureAtlas = false) => {
			displayRecoveryNeedsAtlasClear ||= clearTextureAtlas;
			if (displayRecoveryTimer) clearTimeout(displayRecoveryTimer);
			if (displayRecoveryFrame !== undefined) cancelAnimationFrame(displayRecoveryFrame);
			displayRecoveryTimer = setTimeout(() => {
				displayRecoveryTimer = undefined;
				displayRecoveryFrame = requestAnimationFrame(() => {
					displayRecoveryFrame = undefined;
					const clearTextureAtlas = displayRecoveryNeedsAtlasClear;
					displayRecoveryNeedsAtlasClear = false;
					refreshTerminalDisplay(clearTextureAtlas);
				});
			}, delay);
		};

		const activate = () => {
			const now = Date.now();
			if (now - lastActivationNotice < 750) return;
			if (!connection?.send({ type: 'activate' })) return;
			lastActivationNotice = now;
		};
		activateTerminal = activate;

		const send = (data: string) => {
			activate();
			if (!connection?.send({ type: 'input', data })) return;
			scheduleDisplayRecovery(90);
			const now = Date.now();
			if (now - lastInputNotice >= 750) {
				lastInputNotice = now;
				onInputActivity(sessionId, now);
			}
		};
		sendTerminalInput = send;

		const fitTerminal = (fitAddon: import('@xterm/addon-fit').FitAddon) => {
			fitAddon.fit();
			const dimensions = fitAddon.proposeDimensions();
			if (!dimensions || dimensions.cols < 20 || dimensions.rows < 5) return undefined;
			return { columns: dimensions.cols, rows: dimensions.rows };
		};

		const sendSize = (fitAddon: import('@xterm/addon-fit').FitAddon) => {
			const dimensions = fitTerminal(fitAddon);
			if (!dimensions) return;
			const currentConnection = connection;
			const key = `${dimensions.columns}x${dimensions.rows}`;
			if (currentConnection && (key !== lastSentSize || sentSizeConnection !== currentConnection.connectionId)) {
				activate();
				if (currentConnection.send({ type: 'resize', ...dimensions })) {
					lastSentSize = key;
					sentSizeConnection = currentConnection.connectionId;
				}
			}
			scheduleDisplayRecovery(0);
		};

		const scheduleResize = (fitAddon: import('@xterm/addon-fit').FitAddon, delay = 80) => {
			if (resizeTimer) clearTimeout(resizeTimer);
			if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
			resizeTimer = setTimeout(() => {
				resizeFrame = requestAnimationFrame(() => {
					resizeFrame = undefined;
					sendSize(fitAddon);
				});
			}, delay);
		};

		const handleVisibilityChange = () => {
			if (document.visibilityState !== 'visible') return;
			activate();
			if (fit) scheduleResize(fit, 0);
			scheduleDisplayRecovery(0, true);
			if (terminalReconnecting) reconnectTerminal();
		};
		const handleOnline = () => {
			if (terminalReconnecting) reconnectTerminal();
		};
		const handleThemeChange = () => {
			if (!terminal) return;
			terminal.options.theme = terminalTheme();
			scheduleDisplayRecovery(0, true);
		};
		const handleWindowResize = () => {
			if (fit) scheduleResize(fit);
		};

		openingDelay = setTimeout(() => {
			openingDelay = undefined;
			if (!screenReady && !terminalError) openingVisible = true;
		}, 160);
		window.addEventListener('paste', handleClipboardPaste, true);
		window.addEventListener('focus', handleVisibilityChange);
		window.addEventListener('online', handleOnline);
		window.addEventListener('resize', handleWindowResize);
		window.addEventListener(THEME_CHANGE_EVENT, handleThemeChange);
		document.addEventListener('visibilitychange', handleVisibilityChange);
		window.visualViewport?.addEventListener('resize', handleWindowResize);
		terminalElement.lang = navigator.language || 'und';
		removeTouchScroll = installTerminalTouchScroll(terminalElement, () => terminal, {
			onTap: () => {
				activate();
				terminal?.focus();
				scheduleDisplayRecovery(0);
			}
		});
		focusTerminal = () => terminal?.focus();

		void (async () => {
			const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]);
			if (destroyed) return;
			const desktopInput = isDesktopViewport();
			const savedFontSize = Number(window.localStorage.getItem('vampire:terminal-font-size'));
			fontSize = Number.isFinite(savedFontSize) && savedFontSize >= minimumFontSize && savedFontSize <= maximumFontSize
				? savedFontSize
				: window.matchMedia(COMPACT_MEDIA_QUERY).matches ? 12 : 14;
			terminal = new Terminal({
				cursorBlink: true,
				convertEol: true,
				disableStdin: false,
				fontSize,
				lineHeight: 1.2,
				fontFamily: terminalFontFamily(),
				theme: terminalTheme(),
				scrollback: 10_000
			});
			const fitAddon = new FitAddon();
			fit = fitAddon;
			terminal.loadAddon(fitAddon);
			terminal.open(terminalElement);
			scrollTerminalToTop = () => terminal?.scrollToTop();
			scrollTerminalToBottom = () => terminal?.scrollToBottom();
			screenSync = new TerminalScreenSync({
				reset: () => terminal?.reset(),
				write: (data, complete) => {
					if (!terminal) {
						complete();
						return;
					}
					terminal.write(data, complete);
				},
				refresh: () => refreshTerminalDisplay(),
				onReadyChange: (ready) => {
					screenReady = ready;
					if (!ready) return;
					if (openingDelay) clearTimeout(openingDelay);
					openingDelay = undefined;
				},
				onWriteComplete: () => scheduleDisplayRecovery()
			});
			terminal.attachCustomKeyEventHandler((event) => {
				if (event.key !== 'Enter' || !event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return true;
				event.preventDefault();
				if (event.type === 'keydown') send('\u001b[13;2u');
				return false;
			});
			applyTerminalFontSize = (size) => {
				if (!terminal) return;
				terminal.options.fontSize = size;
				window.localStorage.setItem('vampire:terminal-font-size', String(size));
				scheduleResize(fitAddon);
			};
			inputDisposable = terminal.onData(send);
			const initialSize = fitTerminal(fitAddon);
			const websocketUrl = new URL(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/terminal`);
			websocketUrl.searchParams.set('session', sessionId);
			if (terminalId) websocketUrl.searchParams.set('terminal', terminalId);
			if (initialSize) {
				websocketUrl.searchParams.set('columns', String(initialSize.columns));
				websocketUrl.searchParams.set('rows', String(initialSize.rows));
				lastSentSize = `${initialSize.columns}x${initialSize.rows}`;
			}
			connection = new TerminalConnection(websocketUrl, {
				onOpen: () => {
					if (destroyed) return;
					connected = true;
					terminalReconnecting = false;
					openingStage = 'attaching';
					terminalError = '';
					scheduleDisplayRecovery(0, true);
					if (desktopInput) {
						requestAnimationFrame(() => {
							terminal?.focus();
							directInputFocused = true;
						});
					}
					scheduleResize(fitAddon, 0);
				},
				onMessage: (message, context) => {
					if (destroyed) return;
					if (message.type === 'snapshot') {
						openingVisible = true;
						openingStage = 'restoring';
						screenSync?.beginSnapshot(message.data, {
							isCurrent: context.isCurrent,
							acknowledge: () => context.send({ type: 'snapshot-ready' })
						});
					} else if (message.type === 'screen-ready') {
						screenSync?.markScreenReady();
					} else if (message.type === 'output') {
						if (message.activity && message.activityAt !== null) markOutputActivity(message.activityAt);
						screenSync?.pushOutput(message.data);
					} else if (message.type === 'repository-status') {
						onRepositoryStatus(message.changeCount, message.worktreeCount);
					} else if (message.type === 'error') {
						terminalError = message.message;
					}
				},
				onDisconnect: (event, retrying) => {
					connected = false;
					setOutputActive(false);
					screenSync?.disconnect();
					if (destroyed) return;
					if (retrying) {
						terminalError = '';
						return;
					}
					terminalReconnecting = false;
					terminalError = event.code === 1008 && event.reason === 'authentication expired'
						? 'This terminal session is no longer authorized.'
						: 'Terminal connection closed.';
				},
				onRetrying: () => {
					if (!destroyed) terminalReconnecting = true;
				},
				onReconnectExhausted: () => {
					if (destroyed) return;
					terminalReconnecting = false;
					terminalError = 'The terminal could not connect after several attempts. Try again.';
				},
				onProtocolError: () => {
					if (!destroyed) terminalError = 'The terminal sent an unreadable response.';
				}
			});
			reconnectTerminal = () => {
				if (destroyed) return;
				terminalError = '';
				terminalReconnecting = true;
				connection?.retryNow();
			};
			connection.start();
			observer = new ResizeObserver(() => {
				if (fit) scheduleResize(fit);
			});
			observer.observe(terminalElement);
		})();

		return () => {
			destroyed = true;
			window.removeEventListener('paste', handleClipboardPaste, true);
			window.removeEventListener('focus', handleVisibilityChange);
			window.removeEventListener('online', handleOnline);
			window.removeEventListener('resize', handleWindowResize);
			window.removeEventListener(THEME_CHANGE_EVENT, handleThemeChange);
			document.removeEventListener('visibilitychange', handleVisibilityChange);
			window.visualViewport?.removeEventListener('resize', handleWindowResize);
			removeTouchScroll();
			if (outputActivityTimer) clearTimeout(outputActivityTimer);
			if (resizeTimer) clearTimeout(resizeTimer);
			if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
			if (displayRecoveryTimer) clearTimeout(displayRecoveryTimer);
			if (displayRecoveryFrame !== undefined) cancelAnimationFrame(displayRecoveryFrame);
			if (openingDelay) clearTimeout(openingDelay);
			onOutputActivity(sessionId, false);
			observer?.disconnect();
			inputDisposable?.dispose();
			connection?.stop();
			screenSync?.dispose();
			terminal?.dispose();
			imagePaste.dispose();
			sendTerminalInput = () => undefined;
			scrollTerminalToTop = () => undefined;
			scrollTerminalToBottom = () => undefined;
			activateTerminal = () => undefined;
			focusTerminal = () => undefined;
			applyTerminalFontSize = () => undefined;
			reconnectTerminal = () => undefined;
		};
	});
</script>

<div class="terminal-body">
	<div class="terminal-frame">
		<div
			class="terminal"
			class:path-drop-target={terminalDropActive}
			class:direct-input={directInputFocused}
			class:screen-ready={screenReady}
			bind:this={terminalElement}
			onpointerdown={handleTerminalPointerDown}
			ondragenter={handleTerminalDragOver}
			ondragover={handleTerminalDragOver}
			ondragleave={handleTerminalDragLeave}
			ondrop={handleTerminalDrop}
			onfocusin={() => {
				activateTerminal();
				if (isDesktopViewport()) directInputFocused = true;
			}}
			role="application"
			aria-label="Interactive shell terminal"
		></div>
		{#if !terminalError}
			<ShellOpening
				ready={screenReady}
				visible={openingVisible && !terminalReconnecting && !terminalError}
				stage={openingStage}
			/>
		{/if}
	</div>
	{#if terminalError}
		<div class="terminal-error" role="alert">
			<span>{terminalError}</span>
			<button type="button" onclick={() => location.reload()}>Reconnect</button>
		</div>
	{:else if terminalReconnecting}
		<div class="terminal-connection-status" role="status" aria-live="polite">
			<span>Reconnecting to terminal…</span>
			<button type="button" onclick={reconnectTerminal}>Retry now</button>
		</div>
	{/if}
	{#if imagePaste.message}
		<div class="image-paste-notice" class:uploading={imagePaste.kind === 'uploading'} class:error={imagePaste.kind === 'error'} role={imagePaste.kind === 'error' ? 'alert' : 'status'}>
			{imagePaste.message}
		</div>
	{/if}

	<TerminalInputDock
		{connected}
		send={(data) => sendTerminalInput(data)}
		scrollToTop={() => scrollTerminalToTop()}
		scrollToBottom={() => scrollTerminalToBottom()}
		onComposerFocus={() => directInputFocused = false}
		onImageSelected={(image) => void imagePaste.paste(image)}
		{fontSize}
		{minimumFontSize}
		{maximumFontSize}
		decreaseFontSize={() => changeTerminalFontSize(-1)}
		increaseFontSize={() => changeTerminalFontSize(1)}
	/>
	{#if children}{@render children()}{/if}
</div>

<style>
	.terminal-body { position: relative; display: grid; grid-template-rows: minmax(0, 1fr) auto auto auto; min-width: 0; min-height: 0; overflow: hidden; }
	.terminal-frame { position: relative; min-width: 0; min-height: 0; overflow: hidden; }
	.terminal { width: 100%; height: 100%; min-width: 0; min-height: 0; overflow: hidden; padding: 0.35rem; touch-action: none; }
	.terminal.path-drop-target { box-shadow: inset 0 0 0 2px var(--color-accent); }
	.terminal.direct-input { box-shadow: inset 0 0 0 1px var(--color-visual-accent-glow); }
	.terminal :global(.xterm) { height: 100%; padding: 0.25rem; opacity: 1; touch-action: none; }
	.terminal :global(.xterm-viewport) { overflow-y: scroll; overscroll-behavior: contain; background: var(--color-terminal-background); -webkit-overflow-scrolling: touch; touch-action: none; }
	.terminal :global(.composition-view) { background: var(--color-terminal-background); color: var(--color-terminal-foreground); }
	.terminal :global(.xterm-scrollable-element) { height: 100%; touch-action: none; }
	.terminal-error, .terminal-connection-status, .image-paste-notice { display: flex; align-items: center; justify-content: center; gap: 0.75rem; margin: 0; padding: 0.45rem 0.75rem; font-size: var(--text-label); line-height: var(--leading-ui); text-align: center; }
	.terminal-error { background: var(--color-danger-surface-strong); color: var(--color-danger-text); }
	.terminal-connection-status { border-top: 1px solid var(--color-border-subtle); background: var(--color-surface-raised); color: var(--color-text-secondary); }
	.terminal-error button, .terminal-connection-status button { min-height: 1.9rem; padding: 0 0.65rem; border: 1px solid var(--color-danger-border-strong); border-radius: var(--radius-xs); background: var(--color-danger-surface); color: var(--color-danger-text-strong); font: inherit; font-weight: var(--weight-medium); cursor: pointer; }
	.terminal-connection-status button { border-color: var(--color-border-strong); background: var(--color-control-background); color: var(--color-text); }
	.image-paste-notice { border-top: 1px solid var(--color-border); background: var(--color-success-surface); color: var(--color-success-text); }
	.image-paste-notice.uploading { background: var(--color-warning-surface); color: var(--color-command); }
	.image-paste-notice.error { background: var(--color-danger-surface-strong); color: var(--color-danger-text); }

	@media (prefers-reduced-motion: reduce) {
		.terminal :global(.xterm) { transition: none; }
	}
</style>
