<script lang="ts">
	import { onDestroy, onMount, type Snippet } from 'svelte';
	import type { ManagedSession } from '$lib/session/types';
	import SessionNoteEditor from '$lib/terminal/SessionNoteEditor.svelte';
	import ShellOpening from '$lib/terminal/ShellOpening.svelte';
	import TerminalHeader from '$lib/terminal/TerminalHeader.svelte';
	import TerminalInputDock from '$lib/terminal/TerminalInputDock.svelte';
	import { installTerminalTouchScroll } from '$lib/terminal/touch-scroll';
	import { terminalTheme, THEME_CHANGE_EVENT } from '$lib/theme/theme.svelte';
	import { parseWorkspaceEntryDrag, WORKSPACE_ENTRY_DRAG_TYPE, workspaceEntryDragText } from '$lib/workspace-entry-drag.mjs';
	import type { SystemMetrics } from '$lib/system-metrics';
	import '@xterm/xterm/css/xterm.css';

	let {
		session,
		close,
		onUpdateNote,
		onLoadNote,
		onInputActivity = () => undefined,
		onOutputActivity = () => undefined,
		repositoryOpen = false,
		changeCount = 0,
		worktreeCount = 0,
		onRepositoryStatus = () => undefined,
		onToggleRepository = () => undefined,
		systemMetrics,
		children
	}: {
		session: ManagedSession;
		close: () => void;
		onUpdateNote: (sessionId: string, note: string) => Promise<void>;
		onLoadNote: (sessionId: string) => Promise<string>;
		onInputActivity?: (sessionId: string, timestamp: number) => void;
		onOutputActivity?: (sessionId: string, active: boolean, timestamp?: number) => void;
		repositoryOpen?: boolean;
		changeCount?: number;
		worktreeCount?: number;
		onRepositoryStatus?: (changeCount: number, worktreeCount: number) => void;
		onToggleRepository?: () => void;
		systemMetrics?: SystemMetrics;
		children?: Snippet;
	} = $props();

	let terminalElement: HTMLDivElement;
	let terminalError = $state('');
	let connected = $state(false);
	let outputActive = $state(false);
	let screenReady = $state(false);
	let openingVisible = $state(false);
	let openingStage = $state<'opening' | 'attaching' | 'restoring'>('opening');
	let viewportStyle = $state('');
	let directInputFocused = $state(false);
	let terminalFontSize = $state(14);
	let noteOpen = $state(false);
	let imagePasteKind = $state<'uploading' | 'success' | 'error' | ''>('');
	let imagePasteMessage = $state('');
	let terminalDropActive = $state(false);
	let imagePasteNoticeTimer: ReturnType<typeof setTimeout> | undefined;
	let imagePasteRequestId = 0;
	let sendTerminalInput: (data: string) => void = () => undefined;
	let activateTerminal: () => void = () => undefined;
	let focusTerminal: () => void = () => undefined;
	let applyTerminalFontSize: (size: number) => void = () => undefined;

	const minimumFontSize = 10;
	const maximumFontSize = 22;
	const projectName = $derived(session.cwd.replace(/\/+$/, '').split('/').pop() || session.cwd);

	function changeTerminalFontSize(delta: number) {
		const nextSize = Math.min(maximumFontSize, Math.max(minimumFontSize, terminalFontSize + delta));
		if (nextSize === terminalFontSize) return;
		terminalFontSize = nextSize;
		applyTerminalFontSize(nextSize);
	}

	function handleTerminalPointerDown(event: PointerEvent) {
		activateTerminal();
		if (event.pointerType === 'touch') return;
		focusTerminal();
		if (window.matchMedia('(min-width: 64rem)').matches) directInputFocused = true;
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

	function setImagePasteNotice(kind: typeof imagePasteKind, message: string, duration = 5_000) {
		if (imagePasteNoticeTimer) clearTimeout(imagePasteNoticeTimer);
		imagePasteKind = kind;
		imagePasteMessage = message;
		if (duration > 0) {
			imagePasteNoticeTimer = setTimeout(() => {
				imagePasteKind = '';
				imagePasteMessage = '';
				imagePasteNoticeTimer = undefined;
			}, duration);
		}
	}

	async function pasteImage(image: File) {
		const requestId = ++imagePasteRequestId;
		if (!connected) {
			setImagePasteNotice('error', 'Connect to the terminal before sending an image.');
			return;
		}

		setImagePasteNotice('uploading', 'Sending image to the shell…', 0);
		const form = new FormData();
		form.append('image', image, image.name || 'pasted-image');
		try {
			const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/image`, {
				method: 'POST',
				body: form
			});
			const body: unknown = await response.json().catch(() => undefined);
			if (!response.ok) {
				const message = body && typeof body === 'object' && 'message' in body && typeof body.message === 'string'
					? body.message
					: 'The image could not be pasted into the terminal.';
				throw new Error(message);
			}
			if (requestId === imagePasteRequestId) setImagePasteNotice('success', 'Image pasted into the shell.');
		} catch (error) {
			if (requestId === imagePasteRequestId) {
				setImagePasteNotice('error', error instanceof Error ? error.message : 'Image paste failed.');
			}
		}
	}

	async function handleClipboardPaste(event: ClipboardEvent) {
		const imageItem = Array.from(event.clipboardData?.items ?? []).find(
			(item) => item.kind === 'file' && item.type.startsWith('image/')
		);
		const image = imageItem?.getAsFile();
		if (!image) return;

		event.preventDefault();
		await pasteImage(image);
	}

	onMount(() => {
		let destroyed = false;
		let socket: WebSocket | undefined;
		let terminal: import('@xterm/xterm').Terminal | undefined;
		let observer: ResizeObserver | undefined;
		let inputDisposable: { dispose(): void } | undefined;
		let terminalReady = false;
		let pendingTerminalOutput: string[] = [];
		let outputActivityTimer: ReturnType<typeof setTimeout> | undefined;
		let resizeTimer: ReturnType<typeof setTimeout> | undefined;
		let resizeFrame: number | undefined;
		let terminalRevealDeadline: ReturnType<typeof setTimeout> | undefined;
		let terminalRevealFrame: number | undefined;
		let openingDelay: ReturnType<typeof setTimeout> | undefined;
		let initialScreenSettled = false;
		let pendingTerminalWrites = 0;
		let lastInputNotice = 0;
		let lastActivationNotice = 0;
		let lastSentSize = '';
		let removeTouchScroll: () => void = () => undefined;

		const setOutputActive = (active: boolean, timestamp?: number) => {
			if (active && timestamp !== undefined) onOutputActivity(session.id, true, timestamp);
			if (outputActive === active) return;
			outputActive = active;
			if (!active) onOutputActivity(session.id, false);
		};

		const markOutputActivity = () => {
			setOutputActive(true, Date.now());
			if (outputActivityTimer) clearTimeout(outputActivityTimer);
			outputActivityTimer = setTimeout(() => setOutputActive(false), 2_500);
		};

		const updateViewport = () => {
			if (window.matchMedia('(min-width: 64rem)').matches) {
				viewportStyle = '';
				return;
			}
			const viewport = window.visualViewport;
			const height = Math.round(viewport?.height ?? window.innerHeight);
			const top = Math.round(viewport?.offsetTop ?? 0);
			viewportStyle = `--terminal-viewport-height: ${height}px; --terminal-viewport-top: ${top}px;`;
		};

		const activate = () => {
			if (socket?.readyState !== WebSocket.OPEN) return;
			const now = Date.now();
			if (now - lastActivationNotice < 750) return;
			lastActivationNotice = now;
			socket.send(JSON.stringify({ type: 'activate' }));
		};
		activateTerminal = activate;

		const send = (data: string) => {
			if (socket?.readyState !== WebSocket.OPEN) return;
			activate();
			socket.send(JSON.stringify({ type: 'input', data }));
			const now = Date.now();
			if (now - lastInputNotice >= 750) {
				lastInputNotice = now;
				onInputActivity(session.id, now);
			}
		};
		sendTerminalInput = send;

		const fitTerminal = (fit: import('@xterm/addon-fit').FitAddon) => {
			fit.fit();
			const dimensions = fit.proposeDimensions();
			if (!dimensions || dimensions.cols < 20 || dimensions.rows < 5) return undefined;
			return { columns: dimensions.cols, rows: dimensions.rows };
		};

		const sendSize = (fit: import('@xterm/addon-fit').FitAddon) => {
			const dimensions = fitTerminal(fit);
			if (!dimensions || socket?.readyState !== WebSocket.OPEN) return;
			activate();
			const key = `${dimensions.columns}x${dimensions.rows}`;
			if (key === lastSentSize) return;
			lastSentSize = key;
			socket.send(JSON.stringify({ type: 'resize', ...dimensions }));
		};

		const scheduleResize = (fit: import('@xterm/addon-fit').FitAddon, delay = 80) => {
			if (resizeTimer) clearTimeout(resizeTimer);
			if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
			resizeTimer = setTimeout(() => {
				resizeFrame = requestAnimationFrame(() => {
					resizeFrame = undefined;
					sendSize(fit);
				});
			}, delay);
		};

		const revealTerminal = () => {
			if (terminalRevealDeadline) clearTimeout(terminalRevealDeadline);
			terminalRevealDeadline = undefined;
			if (destroyed || !terminal || screenReady) return;
			terminal.refresh(0, terminal.rows - 1);
			terminalRevealFrame = requestAnimationFrame(() => {
				terminalRevealFrame = requestAnimationFrame(() => {
					terminalRevealFrame = undefined;
					if (!destroyed) {
						screenReady = true;
						if (openingDelay) clearTimeout(openingDelay);
						openingDelay = undefined;
					}
				});
			});
		};

		const revealSettledTerminal = () => {
			if (initialScreenSettled && pendingTerminalWrites === 0) revealTerminal();
		};

		const startTerminalRevealDeadline = () => {
			if (terminalRevealDeadline) clearTimeout(terminalRevealDeadline);
			terminalRevealDeadline = setTimeout(revealTerminal, 1_500);
		};

		const writeTerminalOutput = (data: string) => {
			if (!terminal) return;
			if (screenReady) {
				terminal.write(data);
				return;
			}
			pendingTerminalWrites += 1;
			terminal.write(data, () => {
				pendingTerminalWrites = Math.max(0, pendingTerminalWrites - 1);
				revealSettledTerminal();
			});
		};

		const handleVisibilityChange = () => {
			if (document.visibilityState === 'visible') activate();
		};
		const handleThemeChange = () => {
			if (terminal) terminal.options.theme = terminalTheme();
		};

		updateViewport();
		openingDelay = setTimeout(() => {
			openingDelay = undefined;
			if (!screenReady && !terminalError) openingVisible = true;
		}, 160);
		window.addEventListener('paste', handleClipboardPaste, true);
		window.addEventListener('focus', activate);
		window.addEventListener('resize', updateViewport);
		window.addEventListener(THEME_CHANGE_EVENT, handleThemeChange);
		document.addEventListener('visibilitychange', handleVisibilityChange);
		window.visualViewport?.addEventListener('resize', updateViewport);
		window.visualViewport?.addEventListener('scroll', updateViewport);
		removeTouchScroll = installTerminalTouchScroll(terminalElement, () => terminal, {
			onTap: () => {
				activate();
				terminal?.focus();
			}
		});
		focusTerminal = () => terminal?.focus();

		void (async () => {
			const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]);
			if (destroyed) return;
			const desktopInput = window.matchMedia('(min-width: 64rem)').matches;
			const savedFontSize = Number(window.localStorage.getItem('vampire:terminal-font-size'));
			terminalFontSize = Number.isFinite(savedFontSize) && savedFontSize >= minimumFontSize && savedFontSize <= maximumFontSize
				? savedFontSize
				: window.matchMedia('(max-width: 32rem)').matches ? 12 : 14;
			terminal = new Terminal({
				cursorBlink: true,
				convertEol: true,
				disableStdin: false,
				fontSize: terminalFontSize,
				lineHeight: 1.2,
				fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
				theme: terminalTheme(),
				scrollback: 10_000
			});
			const fit = new FitAddon();
			terminal.loadAddon(fit);
			terminal.open(terminalElement);
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
				scheduleResize(fit);
			};
			inputDisposable = terminal.onData(send);
			const initialSize = fitTerminal(fit);
			const websocketUrl = new URL(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/terminal`);
			websocketUrl.searchParams.set('session', session.id);
			if (initialSize) {
				websocketUrl.searchParams.set('columns', String(initialSize.columns));
				websocketUrl.searchParams.set('rows', String(initialSize.rows));
				lastSentSize = `${initialSize.columns}x${initialSize.rows}`;
			}
			socket = new WebSocket(websocketUrl);
			socket.onopen = () => {
				connected = true;
				openingStage = 'attaching';
				terminalError = '';
				if (desktopInput) {
					requestAnimationFrame(() => {
						terminal?.focus();
						directInputFocused = true;
					});
				}
				scheduleResize(fit, 0);
			};
			socket.onmessage = (event) => {
				let payload: unknown;
				try {
					payload = JSON.parse(String(event.data));
				} catch {
					terminalError = 'The terminal sent an unreadable response.';
					return;
				}
				if (!payload || typeof payload !== 'object') return;
				const message = payload as { type?: unknown; data?: unknown; message?: unknown; activity?: unknown; changeCount?: unknown; worktreeCount?: unknown };
				if (message.type === 'snapshot' && typeof message.data === 'string') {
					if (!terminal) return;
					screenReady = false;
					openingStage = 'restoring';
					initialScreenSettled = false;
					pendingTerminalWrites = 0;
					terminalReady = false;
					pendingTerminalOutput = [];
					terminal.reset();
					terminal.write(message.data, () => {
						if (destroyed || !terminal) return;
						terminalReady = true;
						const pending = pendingTerminalOutput;
						pendingTerminalOutput = [];
						for (const output of pending) writeTerminalOutput(output);
						const acknowledgeAfterPaint = () => {
							if (destroyed || !terminal || socket?.readyState !== WebSocket.OPEN) return;
							terminal.refresh(0, terminal.rows - 1);
							requestAnimationFrame(() => {
								if (destroyed || !terminal || socket?.readyState !== WebSocket.OPEN) return;
								terminal.refresh(0, terminal.rows - 1);
								socket.send(JSON.stringify({ type: 'snapshot-ready' }));
								startTerminalRevealDeadline();
							});
						};
						requestAnimationFrame(acknowledgeAfterPaint);
					});
				} else if (message.type === 'screen-ready') {
					initialScreenSettled = true;
					revealSettledTerminal();
				} else if (message.type === 'output' && typeof message.data === 'string') {
					if (message.activity !== false) markOutputActivity();
					if (terminalReady) writeTerminalOutput(message.data);
					else pendingTerminalOutput.push(message.data);
				} else if (
					message.type === 'repository-status'
					&& typeof message.changeCount === 'number'
					&& Number.isInteger(message.changeCount)
					&& message.changeCount >= 0
				) {
					const worktreeCount = typeof message.worktreeCount === 'number'
						&& Number.isInteger(message.worktreeCount)
						&& message.worktreeCount >= 0
						? message.worktreeCount
						: 0;
					onRepositoryStatus(message.changeCount, worktreeCount);
				} else if (message.type === 'error' && typeof message.message === 'string') {
					terminalError = message.message;
				}
			};
			socket.onerror = () => {
				terminalError = 'Could not connect to this terminal.';
			};
			socket.onclose = (event) => {
				connected = false;
				setOutputActive(false);
				if (!terminalError) {
					terminalError = event.code === 1008 && event.reason === 'authentication expired'
						? 'This terminal session is no longer authorized.'
						: 'Terminal connection closed.';
				}
			};
			observer = new ResizeObserver(() => scheduleResize(fit));
			observer.observe(terminalElement);
		})();

		return () => {
			destroyed = true;
			window.removeEventListener('paste', handleClipboardPaste, true);
			window.removeEventListener('focus', activate);
			window.removeEventListener('resize', updateViewport);
			window.removeEventListener(THEME_CHANGE_EVENT, handleThemeChange);
			document.removeEventListener('visibilitychange', handleVisibilityChange);
			window.visualViewport?.removeEventListener('resize', updateViewport);
			window.visualViewport?.removeEventListener('scroll', updateViewport);
			removeTouchScroll();
			if (outputActivityTimer) clearTimeout(outputActivityTimer);
			if (resizeTimer) clearTimeout(resizeTimer);
			if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
			if (terminalRevealDeadline) clearTimeout(terminalRevealDeadline);
			if (terminalRevealFrame !== undefined) cancelAnimationFrame(terminalRevealFrame);
			if (openingDelay) clearTimeout(openingDelay);
			onOutputActivity(session.id, false);
			observer?.disconnect();
			inputDisposable?.dispose();
			socket?.close();
			terminal?.dispose();
			terminalReady = false;
			pendingTerminalOutput = [];
			sendTerminalInput = () => undefined;
			activateTerminal = () => undefined;
			focusTerminal = () => undefined;
			applyTerminalFontSize = () => undefined;
		};
	});

	onDestroy(() => {
		if (imagePasteNoticeTimer) clearTimeout(imagePasteNoticeTimer);
	});
</script>

<section
	class="terminal-sheet"
	style={viewportStyle}
	aria-label={`Terminal for ${projectName}`}
>
	<div class="terminal-topbar">
		<TerminalHeader
			{projectName}
			cwd={session.cwd}
			hasNote={Boolean(session.notePreview)}
			{noteOpen}
			fontSize={terminalFontSize}
			{minimumFontSize}
			{maximumFontSize}
			{systemMetrics}
			{close}
			{repositoryOpen}
			{changeCount}
			{worktreeCount}
			toggleRepository={onToggleRepository}
			toggleNote={() => noteOpen = !noteOpen}
			decreaseFontSize={() => changeTerminalFontSize(-1)}
			increaseFontSize={() => changeTerminalFontSize(1)}
		/>
		{#if noteOpen}
			<SessionNoteEditor
				getNote={() => onLoadNote(session.id)}
				close={() => noteOpen = false}
				save={async (note) => {
					await onUpdateNote(session.id, note);
				}}
			/>
		{/if}
	</div>

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
					if (window.matchMedia('(min-width: 64rem)').matches) directInputFocused = true;
				}}
				role="application"
				aria-label="Interactive shell terminal"
			></div>
			{#if !terminalError}
				<ShellOpening ready={screenReady} visible={openingVisible} stage={openingStage} />
			{/if}
		</div>
		{#if terminalError}
			<div class="terminal-error" role="alert">
				<span>{terminalError}</span>
				<button type="button" onclick={() => location.reload()}>Reconnect</button>
			</div>
		{/if}
		{#if imagePasteMessage}
			<div class="image-paste-notice" class:uploading={imagePasteKind === 'uploading'} class:error={imagePasteKind === 'error'} role={imagePasteKind === 'error' ? 'alert' : 'status'}>
				{imagePasteMessage}
			</div>
		{/if}

		<TerminalInputDock
			{connected}
			send={(data) => sendTerminalInput(data)}
			onComposerFocus={() => directInputFocused = false}
			onImageSelected={(image) => void pasteImage(image)}
			fontSize={terminalFontSize}
			{minimumFontSize}
			{maximumFontSize}
			decreaseFontSize={() => changeTerminalFontSize(-1)}
			increaseFontSize={() => changeTerminalFontSize(1)}
		/>
		{#if children}{@render children()}{/if}
	</div>
</section>

<style>
	.terminal-sheet { position: fixed; z-index: 20; top: var(--terminal-viewport-top, 0); left: 0; display: grid; grid-template-rows: auto minmax(0, 1fr); width: 100%; height: var(--terminal-viewport-height, 100dvh); min-width: 0; overflow: hidden; background: var(--color-terminal-background); color: var(--color-terminal-foreground); }
	.terminal-topbar { position: relative; z-index: 7; min-width: 0; }
	.terminal-body { position: relative; display: grid; grid-template-rows: minmax(0, 1fr) auto auto auto; min-width: 0; min-height: 0; overflow: hidden; }
	.terminal-frame { position: relative; min-width: 0; min-height: 0; overflow: hidden; }
	.terminal { width: 100%; height: 100%; min-width: 0; min-height: 0; overflow: hidden; padding: 0.35rem; touch-action: none; }
	.terminal.path-drop-target { box-shadow: inset 0 0 0 2px var(--color-accent); }
	.terminal.direct-input { box-shadow: inset 0 0 0 1px var(--color-visual-accent-glow); }
	.terminal :global(.xterm) { height: 100%; padding: 0.25rem; opacity: 0; touch-action: none; transition: opacity 140ms ease-out; }
	.terminal.screen-ready :global(.xterm) { opacity: 1; }
	.terminal :global(.xterm-viewport) { overflow-y: scroll; overscroll-behavior: contain; background: var(--color-terminal-background); -webkit-overflow-scrolling: touch; touch-action: none; }
	.terminal :global(.composition-view) { background: var(--color-terminal-background); color: var(--color-terminal-foreground); }
	.terminal :global(.xterm-scrollable-element) { height: 100%; touch-action: none; }
	.terminal-error, .image-paste-notice { display: flex; align-items: center; justify-content: center; gap: 0.75rem; margin: 0; padding: 0.45rem 0.75rem; font-size: var(--text-label); line-height: var(--leading-ui); text-align: center; }
	.terminal-error { background: var(--color-danger-surface-strong); color: var(--color-danger-text); }
	.terminal-error button { min-height: 1.9rem; padding: 0 0.65rem; border: 1px solid var(--color-danger-border-strong); border-radius: 0.4rem; background: var(--color-danger-surface); color: var(--color-danger-text-strong); font: inherit; font-weight: var(--weight-medium); cursor: pointer; }
	.image-paste-notice { border-top: 1px solid var(--color-border); background: var(--color-success-surface); color: var(--color-success-text); }
	.image-paste-notice.uploading { background: var(--color-warning-surface); color: var(--color-command); }
	.image-paste-notice.error { background: var(--color-danger-surface-strong); color: var(--color-danger-text); }

	@media (min-width: 64rem) {
		.terminal-sheet { position: relative; z-index: 1; top: auto; height: 100dvh; min-height: 0; border: 0; border-radius: 0; }
	}

	@media (prefers-reduced-motion: reduce) {
		.terminal :global(.xterm) { transition: none; }
	}
</style>
