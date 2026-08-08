<script lang="ts">
	import { onMount, untrack, type Snippet } from 'svelte';
	import TerminalInputDock from './TerminalInputDock.svelte';
	import ShellOpening from './ShellOpening.svelte';
	import { TerminalImagePasteState } from './image-paste-state.svelte';
	import {
		TerminalRuntime,
		type TerminalOpeningStage,
		type TerminalRuntimeState
	} from './terminal-runtime.ts';
	import { terminalFontFamily, terminalTheme, THEME_CHANGE_EVENT } from '$lib/theme/theme.svelte';
	import { isDesktopViewport } from '$lib/ui/layout';
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
	let runtime = $state<TerminalRuntime>();
	let terminalError = $state('');
	let connected = $state(false);
	let terminalReconnecting = $state(false);
	let terminalOutputPaused = $state(false);
	let screenReady = $state(false);
	let openingVisible = $state(false);
	let openingStage = $state<TerminalOpeningStage>('opening');
	let directInputFocused = $state(false);
	let terminalDropActive = $state(false);
	const imagePaste = new TerminalImagePasteState(
		untrack(() => sessionId),
		untrack(() => terminalId),
		() => connected
	);

	function applyRuntimeState(state: Readonly<TerminalRuntimeState>) {
		connected = state.connected;
		directInputFocused = state.directInputFocused;
		openingStage = state.openingStage;
		openingVisible = state.openingVisible;
		screenReady = state.screenReady;
		terminalError = state.error;
		terminalOutputPaused = state.outputPaused;
		terminalReconnecting = state.reconnecting;
	}

	function changeTerminalFontSize(delta: number) {
		fontSize = Math.min(maximumFontSize, Math.max(minimumFontSize, fontSize + delta));
	}

	function handleTerminalPointerDown(event: PointerEvent) {
		runtime?.activate();
		if (event.pointerType === 'touch') return;
		runtime?.focus();
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
		runtime?.focus();
		runtime?.send(workspaceEntryDragText(entry));
	}

	$effect(() => {
		const size = fontSize;
		untrack(() => runtime?.setFontSize(size));
	});

	onMount(() => {
		const handleClipboardPaste = (event: ClipboardEvent) => {
			void imagePaste.handleClipboardPaste(event);
		};
		window.addEventListener('paste', handleClipboardPaste, true);
		const terminalRuntime = new TerminalRuntime({
			element: terminalElement,
			sessionId,
			terminalId,
			fontSize,
			minimumFontSize,
			maximumFontSize,
			themeChangeEvent: THEME_CHANGE_EVENT,
			getFontFamily: terminalFontFamily,
			getTheme: terminalTheme,
			onFontSizeChange: (size) => fontSize = size,
			onInputActivity,
			onOutputActivity,
			onRepositoryStatus,
			onStateChange: applyRuntimeState
		});
		runtime = terminalRuntime;
		terminalRuntime.start();

		return () => {
			window.removeEventListener('paste', handleClipboardPaste, true);
			terminalRuntime.dispose();
			imagePaste.dispose();
			if (runtime === terminalRuntime) runtime = undefined;
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
			<button type="button" onclick={terminalOutputPaused ? () => runtime?.reconnect() : () => location.reload()}>
				{terminalOutputPaused ? 'Resume output' : 'Reconnect'}
			</button>
		</div>
	{:else if terminalReconnecting}
		<div class="terminal-connection-status" role="status" aria-live="polite">
			<span>Reconnecting to terminal…</span>
			<button type="button" onclick={() => runtime?.reconnect()}>Retry now</button>
		</div>
	{/if}
	{#if imagePaste.message}
		<div class="image-paste-notice" class:uploading={imagePaste.kind === 'uploading'} class:error={imagePaste.kind === 'error'} role={imagePaste.kind === 'error' ? 'alert' : 'status'}>
			{imagePaste.message}
		</div>
	{/if}

	<TerminalInputDock
		{connected}
		send={(data) => runtime?.send(data)}
		submit={(data) => runtime?.submit(data) ?? false}
		scrollToTop={() => runtime?.scrollToTop()}
		scrollToBottom={() => runtime?.scrollToBottom()}
		onComposerFocus={() => runtime?.markComposerFocused()}
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
