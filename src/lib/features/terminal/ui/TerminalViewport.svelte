<script lang="ts">
import CircleAlert from '@lucide/svelte/icons/circle-alert';
import Crown from '@lucide/svelte/icons/crown';
import MonitorSmartphone from '@lucide/svelte/icons/monitor-smartphone';
import RefreshCw from '@lucide/svelte/icons/refresh-cw';
import { onMount, untrack, type Snippet } from 'svelte';
import Button from '~/lib/shared/ui/Button.svelte';
import TerminalInputDock from './TerminalInputDock.svelte';
import ShellOpening from './ShellOpening.svelte';
import { TerminalImagePasteState } from './image-paste-state.svelte';
import { TerminalRuntime, type TerminalOpeningStage, type TerminalRuntimeState } from './terminal-runtime.ts';
import { terminalFontFamily, terminalTheme, THEME_CHANGE_EVENT } from '~/lib/shared/theme/theme.svelte';
import { isDesktopViewport } from '~/lib/shared/ui/layout';
import {
  parseWorkspaceEntryDrag,
  WORKSPACE_ENTRY_DRAG_TYPE,
  workspaceEntryDragText,
  type TerminalPathInsertionRequest,
  type WorkspaceEntryDragData,
} from '~/lib/shared/lib/workspace-entry-drag.ts';
import '@xterm/xterm/css/xterm.css';

let {
  workspaceId,
  terminalId,
  onInputActivity = () => undefined,
  onOutputActivity = () => undefined,
  onRepositoryStatus = () => undefined,
  pathInsertionRequest,
  onExternalFileDrop = async () => [],
  fontSize = $bindable(14),
  minimumFontSize = 10,
  maximumFontSize = 22,
  inputEnabled = true,
  inputDisabledReason = 'Terminal input is disabled.',
  children,
}: {
  workspaceId: string;
  terminalId?: string;
  onInputActivity?: (workspaceId: string, timestamp: number) => void;
  onOutputActivity?: (workspaceId: string, active: boolean, timestamp?: number) => void;
  onRepositoryStatus?: (changeCount: number, worktreeCount: number) => void;
  pathInsertionRequest?: TerminalPathInsertionRequest;
  onExternalFileDrop?: (dataTransfer: DataTransfer) => Promise<WorkspaceEntryDragData[]>;
  fontSize?: number;
  minimumFontSize?: number;
  maximumFontSize?: number;
  inputEnabled?: boolean;
  inputDisabledReason?: string;
  children?: Snippet;
} = $props();

let terminalElement: HTMLDivElement;
let runtime = $state<TerminalRuntime>();
let terminalError = $state('');
let connected = $state(false);
let controlSizeMismatch = $state(false);
let controlsTerminal = $state<boolean>();
let terminalReconnecting = $state(false);
let terminalOutputPaused = $state(false);
let screenReady = $state(false);
let openingVisible = $state(false);
let openingStage = $state<TerminalOpeningStage>('opening');
let directInputFocused = $state(false);
let terminalDropKind = $state<'' | 'path' | 'files'>('');
let addingDroppedFiles = $state(false);
let droppedFileError = $state('');
let handledPathInsertionToken = 0;
const imagePaste = new TerminalImagePasteState(
  untrack(() => workspaceId),
  untrack(() => terminalId),
  () => connected
);

function applyRuntimeState(state: Readonly<TerminalRuntimeState>) {
  connected = state.connected;
  controlSizeMismatch = state.controlSizeMismatch;
  controlsTerminal = state.controlsTerminal;
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
  if (!inputEnabled) return;
  if (event.pointerType === 'touch') return;
  runtime?.focus();
  if (isDesktopViewport()) directInputFocused = true;
}

function dataTransferTypes(event: DragEvent): string[] {
  return Array.from(event.dataTransfer?.types ?? []);
}

function terminalDropKindForTypes(types: string[]): typeof terminalDropKind {
  if (types.includes(WORKSPACE_ENTRY_DRAG_TYPE)) return 'path';
  if (types.includes('Files')) return 'files';
  return '';
}

function handleTerminalDragOver(event: DragEvent) {
  if (!inputEnabled || !connected || addingDroppedFiles || !event.dataTransfer) return;
  const kind = terminalDropKindForTypes(dataTransferTypes(event));
  if (!kind) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
  terminalDropKind = kind;
}

function handleTerminalDragLeave() {
  terminalDropKind = '';
}

function recoverTerminalOutput() {
  if (terminalOutputPaused) {
    runtime?.reconnect();
    return;
  }
  location.reload();
}

async function handleTerminalDrop(event: DragEvent) {
  terminalDropKind = '';
  if (!inputEnabled || !connected || addingDroppedFiles || !event.dataTransfer) return;
  const raw = event.dataTransfer?.getData(WORKSPACE_ENTRY_DRAG_TYPE);
  const entry = raw ? parseWorkspaceEntryDrag(raw) : undefined;
  if (entry) {
    event.preventDefault();
    runtime?.focus();
    runtime?.send(workspaceEntryDragText(entry));
    return;
  }
  if (!dataTransferTypes(event).includes('Files')) return;
  event.preventDefault();
  addingDroppedFiles = true;
  droppedFileError = '';
  try {
    const entries = await onExternalFileDrop(event.dataTransfer);
    if (entries.length === 0) return;
    runtime?.focus();
    runtime?.send(entries.map(workspaceEntryDragText).join(' '));
  } catch (error) {
    droppedFileError = error instanceof Error ? error.message : 'The dropped files could not be added.';
  } finally {
    addingDroppedFiles = false;
  }
}

$effect(() => {
  const size = fontSize;
  untrack(() => runtime?.setFontSize(size));
});

$effect(() => {
  const enabled = inputEnabled;
  untrack(() => runtime?.setInputEnabled(enabled));
});

$effect(() => {
  const request = pathInsertionRequest;
  if (!inputEnabled || !request || request.token === handledPathInsertionToken || !connected || !runtime) return;
  handledPathInsertionToken = request.token;
  runtime.focus();
  runtime.send(request.entries.map(workspaceEntryDragText).join(' '));
});

onMount(() => {
  const handleClipboardPaste = (event: ClipboardEvent) => {
    if (!inputEnabled) return;
    void imagePaste.handleClipboardPaste(event);
  };
  window.addEventListener('paste', handleClipboardPaste, true);
  const terminalRuntime = new TerminalRuntime({
    element: terminalElement,
    workspaceId,
    terminalId,
    fontSize,
    minimumFontSize,
    maximumFontSize,
    inputEnabled,
    themeChangeEvent: THEME_CHANGE_EVENT,
    getFontFamily: terminalFontFamily,
    getTheme: terminalTheme,
    onFontSizeChange: (size) => (fontSize = size),
    onInputActivity,
    onOutputActivity,
    onRepositoryStatus,
    onStateChange: applyRuntimeState,
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
      class:path-drop-target={Boolean(terminalDropKind)}
      class:direct-input={directInputFocused}
      class:screen-ready={screenReady}
      bind:this={terminalElement}
      onpointerdown={handleTerminalPointerDown}
      ondragenter={handleTerminalDragOver}
      ondragover={handleTerminalDragOver}
      ondragleave={handleTerminalDragLeave}
      ondrop={(event) => void handleTerminalDrop(event)}
      role="application"
      aria-label="Interactive shell terminal"
    ></div>
    {#if terminalDropKind}
      <div class="terminal-drop-prompt" aria-hidden="true">
        {terminalDropKind === 'files' ? 'Copy to workspace and insert path' : 'Insert path into terminal'}
      </div>
    {/if}
    {#if connected && screenReady && controlsTerminal === false}
      <div class="terminal-control-handoff" role="status" aria-live="polite">
        <span class="terminal-status-icon control" aria-hidden="true">
          <MonitorSmartphone size={16} strokeWidth={1.8} />
        </span>
        <span class="terminal-control-label">
          {controlSizeMismatch ? 'Sized for another device' : 'Layout controlled by another device'}
        </span>
        <Button class="terminal-status-action" size="sm" variant="secondary" onclick={() => runtime?.claimControl()}>
          Use this device
        </Button>
      </div>
    {/if}
    {#if !terminalError}
      <ShellOpening
        ready={screenReady}
        visible={openingVisible && !terminalReconnecting && !terminalError}
        stage={openingStage}
      />
    {/if}
    {#if terminalError}
      <div class="terminal-status-card terminal-error" role="alert">
        <span class="terminal-status-icon error" aria-hidden="true">
          <CircleAlert size={17} strokeWidth={1.9} />
        </span>
        <span class="terminal-status-message">{terminalError}</span>
        <Button class="terminal-status-action" size="sm" variant="danger-outline" onclick={recoverTerminalOutput}>
          {terminalOutputPaused ? 'Resume output' : 'Reconnect'}
        </Button>
      </div>
    {:else if terminalReconnecting}
      <div class="terminal-status-card terminal-connection-status" role="status" aria-live="polite">
        <span class="terminal-status-icon reconnecting" aria-hidden="true">
          <RefreshCw size={16} strokeWidth={1.9} />
        </span>
        <span class="terminal-status-message">Reconnecting to terminal…</span>
        <Button class="terminal-status-action" size="sm" variant="secondary" onclick={() => runtime?.reconnect()}>
          Retry now
        </Button>
      </div>
    {/if}
  </div>
  {#if imagePaste.message}
    <div
      class="image-paste-notice"
      class:uploading={imagePaste.kind === 'uploading'}
      class:error={imagePaste.kind === 'error'}
      role={imagePaste.kind === 'error' ? 'alert' : 'status'}
    >
      {imagePaste.message}
    </div>
  {/if}
  {#if addingDroppedFiles || droppedFileError}
    <div
      class="terminal-file-drop-notice"
      class:error={Boolean(droppedFileError)}
      role={droppedFileError ? 'alert' : 'status'}
    >
      {droppedFileError || 'Adding dropped files…'}
    </div>
  {/if}

  {#if !inputEnabled}
    <div class="terminal-input-disabled" role="status">
      <Crown size={15} strokeWidth={1.9} aria-hidden="true" />
      <span>{inputDisabledReason}</span>
    </div>
  {/if}

  <TerminalInputDock
    {connected}
    {inputEnabled}
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
  {#if children}
    {@render children()}
  {/if}
</div>

<style>
.terminal-body {
  position: relative;
  display: grid;
  grid-template-rows: minmax(0, 1fr) auto auto auto auto;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.terminal-frame {
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.terminal-input-disabled {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.45rem;
  min-width: 0;
  padding: 0.48rem 0.75rem;
  border-top: 1px solid var(--color-warning-border);
  background: var(--color-warning-surface);
  color: var(--color-warning-accent);
  font-size: var(--text-caption);
  line-height: var(--leading-ui);
  text-align: center;
}
.terminal {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  padding: 0.35rem;
  touch-action: none;
}
.terminal.path-drop-target {
  box-shadow: inset 0 0 0 2px var(--color-accent);
}
.terminal.direct-input {
  box-shadow: inset 0 0 0 1px var(--color-visual-accent-glow);
}
.terminal :global(.xterm) {
  height: 100%;
  padding: 0.25rem;
  opacity: 1;
  touch-action: none;
}
.terminal :global(.xterm-viewport) {
  overflow-y: scroll;
  overscroll-behavior: contain;
  background: var(--color-terminal-background);
  -webkit-overflow-scrolling: touch;
  touch-action: none;
}
.terminal :global(.composition-view) {
  background: var(--color-terminal-background);
  color: var(--color-terminal-foreground);
}
.terminal :global(.xterm-scrollable-element) {
  height: 100%;
  touch-action: none;
}
.terminal-drop-prompt {
  position: absolute;
  z-index: 3;
  left: 50%;
  bottom: 1rem;
  padding: 0.45rem 0.68rem;
  transform: translateX(-50%);
  border: 1px solid var(--color-accent);
  border-radius: var(--radius-pill);
  background: var(--color-panel);
  box-shadow: var(--shadow-popover);
  color: var(--color-text);
  font-size: var(--text-label);
  pointer-events: none;
  white-space: nowrap;
}
.terminal-control-handoff {
  position: absolute;
  z-index: 4;
  top: 0.75rem;
  right: 0.75rem;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  max-width: calc(100% - 1.5rem);
  padding: 0.38rem;
  border: 1px solid var(--color-border);
  border-radius: 0.78rem;
  background: var(--color-surface-overlay);
  box-shadow: var(--shadow-popover);
  color: var(--color-text-secondary);
  font-size: var(--text-label);
  line-height: var(--leading-ui);
  white-space: nowrap;
}
.terminal-status-icon {
  display: grid;
  flex: 0 0 2rem;
  place-items: center;
  width: 2rem;
  height: 2rem;
  border-radius: 0.58rem;
}
.terminal-status-icon.control {
  background: var(--color-accent-soft);
  color: var(--color-accent-soft-text);
}
.terminal-control-label {
  padding: 0 0.18rem 0 0.05rem;
}
:global(.terminal-status-action) {
  flex: 0 0 auto;
  touch-action: manipulation;
}
.terminal-status-card {
  position: absolute;
  z-index: 5;
  right: 0.75rem;
  bottom: 0.75rem;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.55rem;
  width: max-content;
  max-width: min(30rem, calc(100% - 1.5rem));
  padding: 0.45rem;
  border: 1px solid var(--color-border-strong);
  border-radius: 0.78rem;
  background: var(--color-surface-overlay);
  box-shadow: var(--shadow-popover);
  color: var(--color-text-secondary);
  font-size: var(--text-label);
  line-height: var(--leading-ui);
}
.terminal-status-message {
  min-width: 0;
  padding: 0 0.2rem 0 0.05rem;
  text-align: left;
}
.terminal-status-icon.error {
  background: var(--color-danger-surface);
  color: var(--color-danger-text);
}
.terminal-error {
  border-color: var(--color-danger-border);
}
.terminal-status-icon.reconnecting {
  background: var(--color-warning-surface);
  color: var(--color-warning-accent);
}
.terminal-connection-status .terminal-status-icon :global(svg) {
  animation: terminal-status-spin 0.9s linear infinite;
}
.image-paste-notice {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  margin: 0;
  padding: 0.45rem 0.75rem;
  font-size: var(--text-label);
  line-height: var(--leading-ui);
  text-align: center;
}
.image-paste-notice {
  border-top: 1px solid var(--color-border);
  background: var(--color-success-surface);
  color: var(--color-success-text);
}
.image-paste-notice.uploading {
  background: var(--color-warning-surface);
  color: var(--color-command);
}
.image-paste-notice.error {
  background: var(--color-danger-surface-strong);
  color: var(--color-danger-text);
}
.terminal-file-drop-notice {
  padding: 0.45rem 0.75rem;
  border-top: 1px solid var(--color-border);
  background: var(--color-warning-surface);
  color: var(--color-command);
  font-size: var(--text-label);
  line-height: var(--leading-ui);
  text-align: center;
}
.terminal-file-drop-notice.error {
  background: var(--color-danger-surface-strong);
  color: var(--color-danger-text);
}

@media (max-width: 32rem) {
  .terminal-control-handoff {
    top: 0.5rem;
    right: 0.5rem;
    width: auto;
    max-width: calc(100% - 1rem);
  }
  .terminal-control-label {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .terminal-status-card {
    right: 0.5rem;
    bottom: 0.5rem;
    width: calc(100% - 1rem);
    max-width: none;
  }
}

@keyframes terminal-status-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .terminal :global(.xterm) {
    transition: none;
  }
  .terminal-connection-status .terminal-status-icon :global(svg) {
    animation: none;
  }
}
</style>
