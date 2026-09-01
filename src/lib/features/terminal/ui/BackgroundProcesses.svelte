<script lang="ts">
import Play from '@lucide/svelte/icons/play';
import Plus from '@lucide/svelte/icons/plus';
import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
import Square from '@lucide/svelte/icons/square';
import Star from '@lucide/svelte/icons/star';
import Trash2 from '@lucide/svelte/icons/trash-2';
import { onMount, untrack } from 'svelte';
import type { WorkspaceTerminal } from '~/lib/shared/contracts/workspace';
import Button from '~/lib/shared/ui/Button.svelte';
import DialogEmptyState from '~/lib/shared/ui/DialogEmptyState.svelte';
import DialogToolbar from '~/lib/shared/ui/DialogToolbar.svelte';
import Input from '~/lib/shared/ui/Input.svelte';
import WorkspacePanelHeader from '~/lib/shared/ui/WorkspacePanelHeader.svelte';

let {
  open,
  onOpenChange,
  panelId,
  triggerId,
  processes,
  favoriteCommands,
  starting = false,
  stoppingProcessId,
  updatingFavoriteCommand,
  actionError = '',
  onStart,
  onStop,
  onLoadOutput,
  onFavorite,
  onRemoveFavorite,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  panelId: string;
  triggerId: string;
  processes: WorkspaceTerminal[];
  favoriteCommands: string[];
  starting?: boolean;
  stoppingProcessId?: string;
  updatingFavoriteCommand?: string;
  actionError?: string;
  onStart: (command: string) => Promise<WorkspaceTerminal | undefined>;
  onStop: (process: WorkspaceTerminal) => Promise<boolean>;
  onLoadOutput: (processId: string) => Promise<string>;
  onFavorite: (command: string) => Promise<boolean>;
  onRemoveFavorite: (command: string) => Promise<boolean>;
} = $props();

type View = 'list' | 'runner' | 'output';

let command = $state('');
let commandInput = $state<HTMLInputElement>();
let view = $state<View>('list');
let selectedProcessId = $state<string>();
let output = $state('');
let outputError = $state('');
let outputLoading = $state(false);
let now = $state(Date.now());
let previouslyOpen = false;
const orderedProcesses = $derived([...processes].sort((left, right) => left.index - right.index));
const selectedProcess = $derived(orderedProcesses.find((process) => process.id === selectedProcessId));
const favoriteSet = $derived(new Set(favoriteCommands));
const runningCommands = $derived(
  new Set(orderedProcesses.filter((process) => process.state === 'running').map(processCommand))
);
const dialogTitle = $derived(
  view === 'runner'
    ? 'Run background command'
    : view === 'output' && selectedProcess
      ? processCommand(selectedProcess)
      : 'Background processes'
);

onMount(() => {
  const timer = window.setInterval(() => (now = Date.now()), 1_000);
  return () => window.clearInterval(timer);
});

$effect(() => {
  if (selectedProcessId && !orderedProcesses.some((process) => process.id === selectedProcessId)) {
    selectedProcessId = undefined;
    output = '';
    outputError = '';
    view = 'list';
  }
});

$effect(() => {
  const expanded = open;
  if (expanded && !previouslyOpen) {
    view = 'list';
    selectedProcessId = undefined;
    output = '';
    outputError = '';
  }
  previouslyOpen = expanded;
});

$effect(() => {
  const processId = selectedProcessId;
  if (!open || view !== 'output' || !processId) return;
  // Parent loaders close over reactive workspace state. Only visibility and
  // selection should control this polling lifecycle.
  return untrack(() => startOutputPolling(processId));
});

function startOutputPolling(processId: string): () => void {
  let disposed = false;
  let refreshing = false;
  const refresh = async (initial = false) => {
    if (refreshing) return;
    refreshing = true;
    if (initial) outputLoading = true;
    try {
      const next = await onLoadOutput(processId);
      if (!disposed) {
        output = next;
        outputError = '';
      }
    } catch (error) {
      if (!disposed) outputError = error instanceof Error ? error.message : 'Unable to read output';
    } finally {
      if (!disposed) outputLoading = false;
      refreshing = false;
    }
  };
  void refresh(true);
  const timer = window.setInterval(() => void refresh(), 1_500);
  return () => {
    disposed = true;
    window.clearInterval(timer);
  };
}

function processCommand(process: WorkspaceTerminal): string {
  return process.command || process.name || process.foregroundProcess?.label || 'Background command';
}

function processStatus(process: WorkspaceTerminal): string {
  if (process.state === 'running') return 'Running';
  if (process.exitCode === 0) return 'Finished';
  return process.exitCode === null ? 'Exited' : `Failed (${process.exitCode})`;
}

function processAge(process: WorkspaceTerminal): string {
  if (!process.startedAt) return '';
  const seconds = Math.max(0, Math.floor((now - process.startedAt) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

function processCountLabel(count: number): string {
  return count === 0 ? 'No commands' : `${count} ${count === 1 ? 'command' : 'commands'}`;
}

function openRunner() {
  view = 'runner';
  queueMicrotask(() => commandInput?.focus());
}

function showProcessList() {
  view = 'list';
  selectedProcessId = undefined;
  output = '';
  outputError = '';
}

async function runCommand(value: string): Promise<WorkspaceTerminal | undefined> {
  const normalized = value.trim();
  if (!normalized || starting || runningCommands.has(normalized)) return undefined;
  const process = await onStart(normalized);
  if (!process) return;
  selectedProcessId = process.id;
  output = '';
  outputError = '';
  view = 'output';
  return process;
}

async function startProcess(event: SubmitEvent) {
  event.preventDefault();
  if (!(await runCommand(command))) return;
  command = '';
}

async function stopProcess(event: MouseEvent, process: WorkspaceTerminal) {
  event.stopPropagation();
  if ((await onStop(process)) && selectedProcessId === process.id) {
    showProcessList();
  }
}

function selectProcess(process: WorkspaceTerminal) {
  selectedProcessId = process.id;
  output = '';
  outputError = '';
  view = 'output';
}

async function toggleFavorite(event: MouseEvent, process: WorkspaceTerminal) {
  event.stopPropagation();
  const processCommandValue = processCommand(process);
  if (favoriteSet.has(processCommandValue)) await onRemoveFavorite(processCommandValue);
  else await onFavorite(processCommandValue);
}

function closePanel() {
  onOpenChange(false);
  queueMicrotask(() => document.getElementById(triggerId)?.focus());
}
</script>

{#snippet commandRunner()}
  <div class="background-runner">
    <form onsubmit={startProcess}>
      <Input
        bind:element={commandInput}
        bind:value={command}
        class="background-command-input"
        placeholder="Command to run…"
        ariaLabel="Background command"
        autocomplete="off"
        spellcheck="false"
        maxlength={1000}
        mono
      />
      <Button class="background-run-submit" type="submit" variant="primary" disabled={!command.trim() || starting}
        >{starting ? 'Starting…' : 'Run'}</Button
      >
    </form>
    {#if actionError}
      <p class="background-error runner-error" role="alert">{actionError}</p>
    {/if}
  </div>
{/snippet}

{#snippet favorites()}
  {#if favoriteCommands.length > 0}
    <section class="favorite-strip" aria-label="Favorite background commands">
      <span class="favorite-heading"><Star size={13} strokeWidth={1.8} aria-hidden="true" /> Favorites</span>
      <div class="favorite-list">
        {#each favoriteCommands as favoriteCommand (favoriteCommand)}
          <div class="favorite-command">
            <button
              type="button"
              class="favorite-run"
              disabled={starting || runningCommands.has(favoriteCommand)}
              onclick={() => void runCommand(favoriteCommand)}
              aria-label={`Run favorite ${favoriteCommand}`}
              title={runningCommands.has(favoriteCommand) ? 'Already running' : 'Run command'}
            >
              <Play size={13} strokeWidth={2} aria-hidden="true" />
              <code>{favoriteCommand}</code>
            </button>
            <button
              class="favorite-remove"
              type="button"
              disabled={Boolean(updatingFavoriteCommand)}
              onclick={() => void onRemoveFavorite(favoriteCommand)}
              aria-label={`Remove ${favoriteCommand} from favorites`}
              title="Remove favorite"
            >
              <Trash2 size={13} strokeWidth={1.9} aria-hidden="true" />
            </button>
          </div>
        {/each}
      </div>
    </section>
  {/if}
{/snippet}

{#snippet processActions(process: WorkspaceTerminal)}
  <div class="process-actions">
    <button
      type="button"
      class="process-icon-action"
      class:favorite={favoriteSet.has(processCommand(process))}
      disabled={Boolean(updatingFavoriteCommand)}
      onclick={(event) => void toggleFavorite(event, process)}
      aria-pressed={favoriteSet.has(processCommand(process))}
      aria-label={favoriteSet.has(processCommand(process)) ? `Remove ${processCommand(process)} from favorites` : `Save ${processCommand(process)} as favorite`}
      title={favoriteSet.has(processCommand(process)) ? 'Remove favorite' : 'Save as favorite'}
    >
      <Star
        size={14}
        strokeWidth={1.9}
        fill={favoriteSet.has(processCommand(process)) ? 'currentColor' : 'none'}
        aria-hidden="true"
      />
    </button>
    {#if process.state === 'exited'}
      <button
        type="button"
        class="process-icon-action"
        disabled={starting || runningCommands.has(processCommand(process))}
        onclick={(event) => { event.stopPropagation(); void runCommand(processCommand(process)); }}
        aria-label={`Run ${processCommand(process)} again`}
        title={runningCommands.has(processCommand(process)) ? 'Already running' : 'Run again'}
      >
        <RotateCcw size={14} strokeWidth={1.9} aria-hidden="true" />
      </button>
    {/if}
    <button
      type="button"
      class="stop-process"
      disabled={Boolean(stoppingProcessId)}
      onclick={(event) => void stopProcess(event, process)}
      aria-label={process.state === 'running' ? `Stop ${processCommand(process)}` : `Delete ${processCommand(process)}`}
      title={process.state === 'running' ? 'Stop process' : 'Delete result'}
    >
      {#if process.state === 'running'}
        <Square size={12} strokeWidth={2} aria-hidden="true" />
      {:else}
        <Trash2 size={13} strokeWidth={1.9} aria-hidden="true" />
      {/if}
      <span class="stop-process-label"
        >{stoppingProcessId === process.id ? 'Stopping…' : process.state === 'running' ? 'Stop' : 'Delete'}</span
      >
    </button>
  </div>
{/snippet}

{#snippet processSummaryContent(process: WorkspaceTerminal)}
  <span
    class="process-state"
    class:exited={process.state === 'exited'}
    title={processStatus(process)}
    aria-hidden="true"
  ></span>
  <span class="process-details">
    <code>{processCommand(process)}</code>
    <span class="process-meta">
      <span
        class="process-status"
        class:running={process.state === 'running'}
        class:finished={process.state === 'exited' && process.exitCode === 0}
        class:failed={process.state === 'exited' && process.exitCode !== null && process.exitCode !== 0}
        >{processStatus(process)}</span
      >
      {#if processAge(process)}
        <time title={`Started ${processAge(process)} ago`}>{processAge(process)}</time>
      {/if}
    </span>
  </span>
{/snippet}

{#snippet processList()}
  <div class="process-list" aria-label="Background process list">
    {#if orderedProcesses.length === 0}
      <DialogEmptyState>No background commands</DialogEmptyState>
    {:else}
      {#each orderedProcesses as process (process.id)}
        <div class="process-item">
          <div class="process-row">
            <button
              type="button"
              class="process-summary"
              onclick={() => selectProcess(process)}
              aria-expanded={selectedProcessId === process.id}
              aria-label={`View output for ${processCommand(process)}`}
              title={processCommand(process)}
            >
              {@render processSummaryContent(process)}
            </button>
            {@render processActions(process)}
          </div>
        </div>
      {/each}
    {/if}
  </div>
{/snippet}

{#snippet processOutput(process: WorkspaceTerminal)}
  <section class="process-output" aria-label={`Output for ${processCommand(process)}`}>
    {#if outputError}
      <p class="background-error" role="alert">{outputError}</p>
    {:else if outputLoading}
      <p class="output-placeholder">Loading output…</p>
    {:else}
      <pre>{output || (process.state === 'running' ? 'Waiting for output…' : 'No output captured.')}</pre>
    {/if}
  </section>
{/snippet}

<aside
  id={panelId}
  class="background-panel"
  class:open
  aria-labelledby={`${panelId}-title`}
  aria-hidden={!open}
  inert={!open}
>
  <WorkspacePanelHeader
    title={dialogTitle}
    titleId={`${panelId}-title`}
    close={closePanel}
    closeLabel="Close background manager"
    onBack={view === 'list' ? undefined : showProcessList}
    backLabel="Back to background processes"
  />
  <div class="background-view">
    {#if view === 'list'}
      <DialogToolbar>
        {#if orderedProcesses.length > 0}
          <span>{processCountLabel(orderedProcesses.length)}</span>
        {/if}
        <Button variant="primary" class="background-run-action" onclick={openRunner} ariaLabel="Run background command">
          <Plus size={16} strokeWidth={2} aria-hidden="true" />
          <span>Run command</span>
        </Button>
      </DialogToolbar>
      {@render favorites()}
      <div class="background-content">{@render processList()}</div>
    {:else if view === 'runner'}
      {@render commandRunner()}
      {@render favorites()}
    {:else if selectedProcess}
      <div class="background-detail-bar">
        <span
          class="process-status"
          class:running={selectedProcess.state === 'running'}
          class:finished={selectedProcess.state === 'exited' && selectedProcess.exitCode === 0}
          class:failed={selectedProcess.state === 'exited' && selectedProcess.exitCode !== null && selectedProcess.exitCode !== 0}
          >{processStatus(selectedProcess)}</span
        >
        {@render processActions(selectedProcess)}
      </div>
      {@render processOutput(selectedProcess)}
    {/if}
  </div>
</aside>

<style>
.background-panel {
  position: absolute;
  z-index: 10;
  top: 0;
  right: 0;
  display: flex;
  flex-direction: column;
  width: var(--workspace-panel-width, min(22rem, calc(100% - 3rem)));
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  transform: translateX(100%);
  border-left: 1px solid var(--color-border);
  background: var(--color-panel);
  box-shadow: var(--shadow-repository-panel);
  color: var(--color-text);
  pointer-events: none;
}
.background-panel.open {
  transform: translateX(0);
  pointer-events: auto;
}
.background-view {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  padding: 0.75rem;
}
:global(.background-run-action) {
  margin-left: auto;
}
.background-runner {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  align-items: center;
  gap: 0.75rem 1rem;
  padding: 0 0 0.8rem;
  border-bottom: 1px solid var(--color-border-subtle);
}
.background-runner form {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  min-width: 0;
}
:global(.background-command-input) {
  height: 2.35rem;
  min-height: 2.35rem;
  border-color: var(--color-border);
  border-right: 0;
  border-radius: var(--radius-control) 0 0 var(--radius-control);
  font-size: var(--text-caption);
}
:global(.background-command-input:focus) {
  border-color: var(--color-accent);
  box-shadow: inset 0 0 0 1px var(--color-accent);
}
:global(.background-run-submit) {
  min-width: 4.5rem;
  border-radius: 0 var(--radius-control) var(--radius-control) 0;
}
.background-error {
  margin: 0;
  color: var(--color-danger-text);
  font-size: var(--text-caption);
}
.favorite-strip {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 0.7rem;
  min-height: 2.7rem;
  padding: 0.35rem 0;
  border-bottom: 1px solid var(--color-border-subtle);
}
.favorite-heading {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  color: var(--color-text-secondary);
  font-size: var(--text-caption);
  font-weight: var(--weight-medium);
  white-space: nowrap;
}
.favorite-list {
  display: flex;
  gap: 0.4rem;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: thin;
}
.favorite-command {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 2rem;
  flex: 0 0 auto;
  align-items: center;
  max-width: min(24rem, 62vw);
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-control);
  background: var(--color-control-background);
}
.favorite-command button {
  border: 0;
  background: transparent;
  color: var(--color-text-tertiary);
  cursor: pointer;
}
.favorite-command code {
  min-width: 0;
  overflow: hidden;
  color: var(--color-text-secondary);
  font-family: var(--font-mono);
  font-size: var(--text-caption);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.favorite-run {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  min-width: 0;
  min-height: 2.15rem;
  padding: 0 0.65rem;
  text-align: left;
}
@media (hover: hover) {
  .favorite-run:hover:not(:disabled) {
    background: var(--color-surface-hover);
    color: var(--color-text);
  }
  .favorite-run:hover:not(:disabled) code {
    color: var(--color-text);
  }
}
.favorite-remove {
  display: grid;
  place-items: center;
  width: 1.9rem;
  height: 2.15rem;
  padding: 0;
  border-left: 1px solid var(--color-border);
}
@media (hover: hover) {
  .favorite-remove:hover:not(:disabled) {
    background: var(--color-surface-hover);
    color: var(--color-text);
  }
}
.favorite-command button:disabled {
  cursor: default;
  opacity: 0.42;
}
.background-content {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding-top: 0.65rem;
  overscroll-behavior: contain;
}
.process-list {
  min-width: 0;
  min-height: 0;
  display: grid;
  gap: 0.4rem;
}
.output-placeholder {
  margin: 0;
  padding: 1rem;
  color: var(--color-text-tertiary);
  font-size: var(--text-caption);
}
.process-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  min-width: 0;
}
.process-item {
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-control);
  background: var(--color-surface-raised);
}
.process-summary,
.process-icon-action,
.stop-process {
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.process-summary {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 0.6rem;
  min-width: 0;
  min-height: 2.85rem;
  padding: 0.55rem 0.65rem 0.55rem 0.7rem;
  text-align: left;
}
@media (hover: hover) {
  .process-summary:hover,
  .process-icon-action:hover:not(:disabled),
  .stop-process:hover:not(:disabled) {
    background: var(--color-surface-hover);
  }
}
.process-state {
  width: 0.55rem;
  height: 0.55rem;
  border-radius: 50%;
  background: var(--color-success);
  box-shadow: var(--shadow-status-active);
}
.process-state.exited {
  background: var(--color-text-disabled);
  box-shadow: none;
}
.process-status {
  padding: 0.2rem 0.5rem;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-pill);
  background: var(--color-surface-raised);
  color: var(--color-text-tertiary);
  font-size: var(--text-caption);
  font-weight: var(--weight-medium);
  line-height: 1.25;
  white-space: nowrap;
}
.process-status.running {
  border-color: transparent;
  background: var(--color-success-surface);
  color: var(--color-success-text);
}
.process-status.finished {
  color: var(--color-text-secondary);
}
.process-status.failed {
  border-color: var(--color-danger-border);
  background: var(--color-danger-surface);
  color: var(--color-danger-text);
}
.process-details {
  display: grid;
  min-width: 0;
  gap: 0.3rem;
}
.process-summary code {
  display: block;
  min-width: 0;
  color: var(--color-text);
  font-family: var(--font-mono);
  font-size: var(--text-label);
  font-weight: var(--weight-medium);
  line-height: 1.35;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.process-meta {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
}
.process-summary time {
  color: var(--color-text-tertiary);
  font-size: var(--text-caption);
  white-space: nowrap;
}
.process-actions {
  display: flex;
  align-items: stretch;
  gap: 0.05rem;
  min-width: 0;
}
.process-icon-action {
  display: grid;
  place-items: center;
  width: 2.25rem;
  padding: 0;
  color: var(--color-text-disabled);
}
.process-icon-action.favorite {
  color: var(--color-warning-accent);
}
.process-icon-action:disabled,
.stop-process:disabled {
  cursor: wait;
  opacity: 0.5;
}
.stop-process {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.35rem;
  min-width: 4.6rem;
  padding: 0 0.7rem;
  color: var(--color-text-tertiary);
  font-size: var(--text-caption);
}
.stop-process-label {
  white-space: nowrap;
}
.process-output {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  flex: 1 1 auto;
  border-top: 1px solid var(--color-border-subtle);
  background: var(--color-surface-raised);
}
.background-detail-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 3rem;
  border-bottom: 1px solid var(--color-border-subtle);
}
.background-detail-bar .process-actions {
  min-height: 3rem;
}
.background-detail-bar .process-icon-action {
  width: 2.75rem;
}
.background-detail-bar .stop-process {
  min-width: 5.25rem;
  width: auto;
}
.process-output pre {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  margin: 0;
  padding: 0.7rem 0.85rem 0.85rem 1.05rem;
  background: var(--color-surface-raised);
  color: var(--color-terminal-foreground);
  font-family: var(--font-mono);
  font-size: var(--text-caption);
  line-height: 1.45;
  scrollbar-gutter: stable;
  white-space: pre-wrap;
  word-break: break-word;
}

@media (min-width: 80rem) {
  .background-panel {
    position: relative;
    z-index: 1;
    top: auto;
    right: auto;
    grid-column: 2;
    grid-row: 1;
    width: 100%;
    height: 100%;
    transform: none;
    box-shadow: none;
    visibility: hidden;
  }
  .background-panel.open {
    visibility: visible;
  }
}

@media (width < 80rem) {
  .background-panel {
    position: fixed;
    z-index: 40;
    width: var(--workspace-panel-width, min(23rem, calc(100% - 2.75rem)));
    height: 100dvh;
    padding-top: env(safe-area-inset-top);
    padding-bottom: env(safe-area-inset-bottom);
    transition: transform 180ms ease;
  }
}

@media (prefers-reduced-motion: reduce) {
  .background-panel {
    transition: none;
  }
}
</style>
