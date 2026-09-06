<script lang="ts">
import CircleAlert from '@lucide/svelte/icons/circle-alert';
import MonitorSmartphone from '@lucide/svelte/icons/monitor-smartphone';
import RefreshCw from '@lucide/svelte/icons/refresh-cw';
import { onMount, type Snippet, tick, untrack } from 'svelte';
import {
  parseWorkspaceEntryDragEntries,
  type TerminalPathInsertionRequest,
  WORKSPACE_ENTRY_DRAG_TYPE,
  type WorkspaceEntryDragData,
  workspaceEntryDragText,
} from '~/lib/shared/lib/workspace-entry-drag.ts';
import { THEME_CHANGE_EVENT, terminalFontFamily, terminalTheme } from '~/lib/shared/theme/theme.svelte';
import Button from '~/lib/shared/ui/Button.svelte';
import { SubmissionRecovery } from '../model/submission-recovery.svelte.ts';
import { TerminalImagePasteState } from './image-paste-state.svelte';
import ShellOpening from './ShellOpening.svelte';
import TerminalInputDock from './TerminalInputDock.svelte';
import {
  acquireTerminalRuntime,
  releaseTerminalRuntime,
  type TerminalOpeningStage,
  type TerminalRuntime,
  type TerminalRuntimeState,
} from './terminal-runtime.ts';
import '@xterm/xterm/css/xterm.css';
import type { WorkspaceComposerPrompt } from '~/lib/shared/contracts/workspace-composer-history.ts';
import type { ComposerTemplateContext } from '~/lib/shared/lib/composer-template.ts';
import { hasFinePointer } from '~/lib/shared/ui/layout';
import { isUiOverlayOpen } from '~/lib/shared/ui/overlay.ts';
import {
  loadLastFocusedInputSurface,
  saveLastFocusedInputSurface,
  type TerminalInputSurface,
} from '../model/input-surface-preference.ts';

let {
  workspaceId,
  terminalId,
  composerTemplate,
  composerTemplateContext,
  onInputActivity = () => undefined,
  onOutputActivity = () => undefined,
  composerHistoryEnabled = true,
  onRecordComposerPrompt,
  onLoadComposerPrompts,
  onRepositoryStatus = () => undefined,
  pathInsertionRequest,
  onExternalFileDrop = async () => [],
  fontSize = $bindable(14),
  minimumFontSize = 10,
  maximumFontSize = 22,
  children,
}: {
  workspaceId: string;
  terminalId?: string;
  composerTemplate?: string;
  composerTemplateContext: ComposerTemplateContext;
  onInputActivity?: (workspaceId: string, timestamp: number) => void;
  onOutputActivity?: (workspaceId: string, active: boolean, timestamp?: number) => void;
  composerHistoryEnabled?: boolean;
  onRecordComposerPrompt: (workspaceId: string, prompt: string) => Promise<void>;
  onLoadComposerPrompts: (workspaceId: string, refresh?: boolean) => Promise<WorkspaceComposerPrompt[]>;
  onRepositoryStatus?: (changeCount: number, worktreeCount: number, branch?: string) => void;
  pathInsertionRequest?: TerminalPathInsertionRequest;
  onExternalFileDrop?: (dataTransfer: DataTransfer) => Promise<WorkspaceEntryDragData[]>;
  fontSize?: number;
  minimumFontSize?: number;
  maximumFontSize?: number;
  children?: Snippet;
} = $props();

let terminalElement: HTMLDivElement;
let composerElement = $state<HTMLTextAreaElement>();
let runtime = $state<TerminalRuntime>();
let submissionRecovery = $state<SubmissionRecovery>();
let inputOwner = $state<TerminalInputSurface>('compose');
let terminalError = $state('');
let connected = $state(false);
let inputReady = $state(false);
let controlSizeMismatch = $state(false);
let controlsTerminal = $state<boolean>();
let terminalReconnecting = $state(false);
let terminalOutputPaused = $state(false);
let screenReady = $state(false);
let openingVisible = $state(false);
let openingStage = $state<TerminalOpeningStage>('opening');
let terminalDropKind = $state<'' | 'path' | 'files'>('');
let addingDroppedFiles = $state(false);
let droppedFileError = $state('');
let handledPathInsertionToken = 0;
let savedInputOwner: TerminalInputSurface | undefined;
let mountFocusBaseline: Element | null = null;
let initialAutoFocusSuppressed = false;
const imagePaste = new TerminalImagePasteState(
  untrack(() => workspaceId),
  untrack(() => terminalId),
  () => connected
);

function shouldPreserveExistingFocus(): boolean {
  if (initialAutoFocusSuppressed) return true;
  const activeElement = document.activeElement;
  if (activeElement instanceof HTMLElement && activeElement.dataset.terminalAutofocus === 'preserve') {
    delete activeElement.dataset.terminalAutofocus;
    initialAutoFocusSuppressed = true;
    return true;
  }
  if (isUiOverlayOpen()) {
    initialAutoFocusSuppressed = true;
    return true;
  }
  const baselineWasRemoved = !mountFocusBaseline?.isConnected;
  const documentHasFallbackFocus =
    activeElement === null || activeElement === document.body || activeElement === document.documentElement;
  if (
    activeElement !== mountFocusBaseline &&
    activeElement !== composerElement &&
    !(activeElement instanceof Node && terminalElement.contains(activeElement)) &&
    !(baselineWasRemoved && documentHasFallbackFocus)
  ) {
    initialAutoFocusSuppressed = true;
    return true;
  }
  return false;
}

function applyRuntimeState(state: Readonly<TerminalRuntimeState>) {
  connected = state.connected;
  controlSizeMismatch = state.controlSizeMismatch;
  controlsTerminal = state.controlsTerminal;
  inputReady = state.inputReady;
  openingStage = state.openingStage;
  openingVisible = state.openingVisible;
  screenReady = state.screenReady;
  terminalError = state.error;
  terminalOutputPaused = state.outputPaused;
  terminalReconnecting = state.reconnecting;
}

function chooseInputOwner(mode: TerminalInputSurface) {
  inputOwner = mode;
  if (savedInputOwner === mode) return;
  saveLastFocusedInputSurface(workspaceId, terminalId, mode);
  savedInputOwner = mode;
}

function focusTerminalInput() {
  if (!inputReady) {
    focusComposerInput();
    return false;
  }
  chooseInputOwner('terminal');
  runtime?.focus();
  return true;
}

function focusComposerInput() {
  chooseInputOwner('compose');
  composerElement?.focus({ preventScroll: true });
}

function toggleInputSurface() {
  if (inputOwner === 'terminal') focusComposerInput();
  else focusTerminalInput();
}

function dataTransferTypes(event: DragEvent): string[] {
  return Array.from(event.dataTransfer?.types ?? []);
}

function handleTerminalDragOver(event: DragEvent) {
  if (!connected || addingDroppedFiles || !event.dataTransfer) return;
  const types = dataTransferTypes(event);
  const kind = types.includes(WORKSPACE_ENTRY_DRAG_TYPE) ? 'path' : types.includes('Files') ? 'files' : '';
  if (!kind) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
  terminalDropKind = kind;
}

function handleTerminalDragLeave() {
  terminalDropKind = '';
}

async function handleTerminalDrop(event: DragEvent) {
  terminalDropKind = '';
  if (!connected || addingDroppedFiles || !event.dataTransfer) return;
  const raw = event.dataTransfer?.getData(WORKSPACE_ENTRY_DRAG_TYPE);
  const draggedEntries = raw ? parseWorkspaceEntryDragEntries(raw) : undefined;
  if (draggedEntries?.length) {
    event.preventDefault();
    if (runtime?.send(draggedEntries.map(workspaceEntryDragText).join(' '))) focusTerminalInput();
    return;
  }
  if (!dataTransferTypes(event).includes('Files')) return;
  event.preventDefault();
  addingDroppedFiles = true;
  droppedFileError = '';
  try {
    const entries = await onExternalFileDrop(event.dataTransfer);
    if (entries.length === 0) return;
    if (runtime?.send(entries.map(workspaceEntryDragText).join(' '))) focusTerminalInput();
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
  const request = pathInsertionRequest;
  if (!request || request.token === handledPathInsertionToken || !connected || !runtime) return;
  if (!runtime.send(request.entries.map(workspaceEntryDragText).join(' '))) return;
  handledPathInsertionToken = request.token;
  focusTerminalInput();
});

onMount(() => {
  submissionRecovery = new SubmissionRecovery(workspaceId, terminalId);
  const recovery = submissionRecovery;
  mountFocusBaseline = document.activeElement;
  savedInputOwner = loadLastFocusedInputSurface(workspaceId, terminalId).value;
  inputOwner = savedInputOwner ?? 'compose';
  let disposed = false;
  const handleClipboardPaste = (event: ClipboardEvent) => {
    void imagePaste.handleClipboardPaste(event);
  };
  window.addEventListener('paste', handleClipboardPaste, true);
  terminalElement.addEventListener('click', focusTerminalInput);
  const terminalRuntime = acquireTerminalRuntime({
    element: terminalElement,
    workspaceId,
    terminalId,
    fontSize,
    minimumFontSize,
    maximumFontSize,
    themeChangeEvent: THEME_CHANGE_EVENT,
    getFontFamily: terminalFontFamily,
    getTheme: terminalTheme,
    shouldAutoFocus: () => inputOwner === 'terminal' && !shouldPreserveExistingFocus(),
    onFontSizeChange: (size) => (fontSize = size),
    onComposeShortcut: toggleInputSurface,
    onInputActivity,
    onTerminalInput: () => chooseInputOwner('terminal'),
    onOutputActivity,
    onRepositoryStatus,
    onStateChange: applyRuntimeState,
    onTerminalTap: focusTerminalInput,
    onSubmissionResult: (result) => recovery.applyResult(result),
    onSubmissionUncertain: (requestId) => recovery.markUncertain(requestId),
  });
  runtime = terminalRuntime;
  recovery.resumePending(terminalRuntime.pendingSubmissionIds);
  terminalRuntime.start();
  void tick().then(() => {
    requestAnimationFrame(() => {
      if (disposed || inputOwner !== 'compose' || !hasFinePointer() || shouldPreserveExistingFocus()) return;
      composerElement?.focus({ preventScroll: true });
    });
  });

  return () => {
    disposed = true;
    window.removeEventListener('paste', handleClipboardPaste, true);
    terminalElement.removeEventListener('click', focusTerminalInput);
    releaseTerminalRuntime(terminalRuntime);
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
      class:screen-ready={screenReady}
      bind:this={terminalElement}
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
        <Button
          class="terminal-status-action"
          size="sm"
          variant="danger-outline"
          onclick={terminalOutputPaused ? () => runtime?.reconnect() : () => location.reload()}
        >
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

  {#if submissionRecovery?.error || submissionRecovery?.persistenceFailed}
    <p class="terminal-file-drop-notice" role="status">
      {submissionRecovery.error || 'Message recovery is available for this visit, but could not be saved in this browser.'}
    </p>
  {/if}
  <TerminalInputDock
    bind:composerElement
    inputSurface={inputOwner}
    {workspaceId}
    {terminalId}
    connected={connected && inputReady}
    {composerTemplate}
    {composerTemplateContext}
    sendControl={(control) => runtime?.sendControl(control)}
    submit={(data, draft) => submissionRecovery?.submit(data, draft, (text, requestId) => runtime?.submit(text, requestId) ?? false) ?? false}
    recoverableSubmissions={submissionRecovery?.entries ?? []}
    onDismissSubmission={(requestId) => submissionRecovery?.dismiss(requestId)}
    {composerHistoryEnabled}
    scrollPageUp={() => runtime?.scrollPageUp()}
    scrollPageDown={() => runtime?.scrollPageDown()}
    onSubmitted={(prompt) => onRecordComposerPrompt(workspaceId, prompt)}
    loadPrompts={(refresh) => onLoadComposerPrompts(workspaceId, refresh)}
    scrollToTop={() => runtime?.scrollToTop()}
    scrollToBottom={() => runtime?.scrollToBottom()}
    onImageSelected={(image) => void imagePaste.paste(image)}
    handoffToTerminal={(data) => {
      if (!runtime?.send(data)) return false;
      focusTerminalInput();
      return true;
    }}
    onToggleInputSurface={toggleInputSurface}
    onComposerFocus={() => chooseInputOwner('compose')}
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
.terminal {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  padding: 0.35rem max(0.35rem, env(safe-area-inset-right)) 0.35rem max(0.35rem, env(safe-area-inset-left));
  touch-action: none;
}
.terminal.path-drop-target {
  box-shadow: inset 0 0 0 2px var(--color-accent);
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
