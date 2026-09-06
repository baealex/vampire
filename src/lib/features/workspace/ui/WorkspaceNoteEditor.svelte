<script lang="ts">
import { onDestroy, onMount, tick } from 'svelte';
import Sparkles from '@lucide/svelte/icons/sparkles';
import X from '@lucide/svelte/icons/x';
import Button from '~/lib/shared/ui/Button.svelte';
import Textarea from '~/lib/shared/ui/Textarea.svelte';
import WorkspacePanelHeader from '~/lib/shared/ui/WorkspacePanelHeader.svelte';
import AskAgentDialog from '~/lib/shared/ui/AskAgentDialog.svelte';
import {
  loadWorkspaceAgentAction,
  submitWorkspaceAgentAction as submitWorkspaceAgentActionRequest,
} from '~/lib/shared/api/workspace-agent-actions.ts';
import type {
  WorkspaceAgentActionDescriptor,
  WorkspaceAgentActionSubmission,
} from '~/lib/shared/contracts/workspace-agent-actions.ts';

const AUTOSAVE_DELAY_MS = 700;
const AGENT_NOTE_REFRESH_MS = 2_000;

let {
  workspaceId,
  getNote,
  close,
  save,
  loadAgentAction = () => loadWorkspaceAgentAction(workspaceId, 'note'),
  submitAgentAction = (request: string) => submitWorkspaceAgentActionRequest(workspaceId, 'note', request),
  askAgentAvailable = true,
  panel = false,
  onBusyChange = () => undefined,
  onFlushAvailable = () => undefined,
  onPanelLockChange = () => undefined,
}: {
  workspaceId: string;
  getNote: (refresh?: boolean) => Promise<string>;
  close: () => void;
  save: (note: string) => Promise<void>;
  loadAgentAction?: () => Promise<WorkspaceAgentActionDescriptor>;
  submitAgentAction?: (request: string) => Promise<WorkspaceAgentActionSubmission>;
  askAgentAvailable?: boolean;
  panel?: boolean;
  onBusyChange?: (busy: boolean) => void;
  onFlushAvailable?: (flush: (() => Promise<boolean>) | undefined) => void;
  onPanelLockChange?: (locked: boolean) => void;
} = $props();

let draft = $state('');
let savedNote = $state('');
let noteLoading = $state(true);
let noteLoaded = $state(false);
let noteLoadError = $state('');
let saving = $state(false);
let saveError = $state('');
let textarea = $state<HTMLTextAreaElement | undefined>();
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let savePromise: Promise<void> | undefined;
let agentNoteSyncTimer: ReturnType<typeof setInterval> | undefined;
let agentDialogOpen = $state(false);
let agentSubmitting = $state(false);
let agentUpdatePending = $state(false);
let agentUpdateMessage = $state('');
let refreshingAgentNote = false;
let destroyed = false;
let saveStatus = $derived(
  saving ? 'Saving…' : saveError ? 'Save failed' : draft === savedNote ? 'Saved' : 'Saving soon…'
);

$effect(() => onBusyChange(saving || agentSubmitting || (noteLoaded && draft !== savedNote)));
$effect(() => onPanelLockChange(agentSubmitting));

async function loadNote() {
  noteLoading = true;
  noteLoadError = '';
  try {
    const note = await getNote();
    draft = note;
    savedNote = note;
    noteLoaded = true;
    noteLoading = false;
    startAgentNoteSync();
    await tick();
    textarea?.focus();
  } catch (error) {
    noteLoadError = error instanceof Error ? error.message : 'The note could not be loaded.';
  } finally {
    noteLoading = false;
  }
}

onMount(() => {
  onFlushAvailable(flushDraftForNavigation);
  void loadNote();
});

function clearSaveTimer() {
  if (saveTimer === undefined) return;
  clearTimeout(saveTimer);
  saveTimer = undefined;
}

function scheduleSave() {
  clearSaveTimer();
  saveError = '';
  if (draft === savedNote) return;
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    void saveDraft();
  }, AUTOSAVE_DELAY_MS);
}

async function saveDraft(): Promise<void> {
  if (!noteLoaded) return;
  if (savePromise) {
    await savePromise;
    if (draft === savedNote) return;
  }
  if (draft === savedNote) return;

  const value = draft;
  saving = true;
  saveError = '';
  const currentSave = (async () => {
    try {
      await save(value);
      savedNote = value;
    } catch (error) {
      saveError = error instanceof Error ? error.message : 'The note could not be saved.';
    }
  })();
  savePromise = currentSave;
  try {
    await currentSave;
  } finally {
    if (savePromise === currentSave) {
      savePromise = undefined;
      saving = false;
    }
  }
  if (draft !== savedNote && !saveError && saveTimer === undefined) scheduleSave();
}

async function flushDraftForNavigation(): Promise<boolean> {
  if (agentSubmitting) return false;
  clearSaveTimer();
  await saveDraft();
  return !noteLoaded || draft === savedNote;
}

async function closeEditor() {
  clearSaveTimer();
  if (!noteLoaded) {
    close();
    return;
  }
  await saveDraft();
  if (draft !== savedNote) return;
  await tick();
  close();
}

function stopAgentNoteSync() {
  if (agentNoteSyncTimer === undefined) return;
  clearInterval(agentNoteSyncTimer);
  agentNoteSyncTimer = undefined;
}

async function refreshAgentNote() {
  if (!noteLoaded || refreshingAgentNote || saving || draft !== savedNote) return;
  refreshingAgentNote = true;
  try {
    const note = await getNote(true);
    if (destroyed || note === savedNote || draft !== savedNote) return;
    draft = note;
    savedNote = note;
    if (agentUpdatePending) {
      agentUpdatePending = false;
      agentUpdateMessage = 'The note changed. Live sync is on.';
    }
  } catch {
    // The regular save/load surfaces errors; live sync remains quiet and retries.
  } finally {
    refreshingAgentNote = false;
  }
}

function startAgentNoteSync() {
  stopAgentNoteSync();
  agentNoteSyncTimer = setInterval(() => void refreshAgentNote(), AGENT_NOTE_REFRESH_MS);
}

async function submitAgentRequest(request: string): Promise<WorkspaceAgentActionSubmission> {
  if (!noteLoaded) throw new Error('The note is not ready.');
  clearSaveTimer();
  await saveDraft();
  if (draft !== savedNote) throw new Error(saveError || 'Save the note before asking the agent.');
  return submitAgentAction(request);
}

function handleAgentRequestSubmitted() {
  agentUpdatePending = true;
  agentUpdateMessage = '';
  startAgentNoteSync();
}

async function closeAgentView() {
  agentDialogOpen = false;
  await tick();
  document.getElementById('workspace-note-ask-agent')?.focus();
}

function handleEditorKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault();
    void closeEditor();
  } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    clearSaveTimer();
    void saveDraft();
  }
}

onDestroy(() => {
  onFlushAvailable(undefined);
  destroyed = true;
  clearSaveTimer();
  stopAgentNoteSync();
  if (noteLoaded && draft !== savedNote) void saveDraft();
});
</script>

{#snippet askAgentAction()}
  <Button
    id="workspace-note-ask-agent"
    variant="secondary"
    size="sm"
    onclick={() => (agentDialogOpen = true)}
    disabled={noteLoading || !noteLoaded || Boolean(saveError) || !askAgentAvailable}
    title={askAgentAvailable ? 'Ask agent about this note' : 'Start a foreground process in the main terminal first.'}
  >
    <Sparkles size={16} strokeWidth={1.8} aria-hidden="true" />
    Ask agent…
  </Button>
{/snippet}

<section
  class="note-editor"
  class:panel
  aria-label={agentDialogOpen ? 'Ask agent about this note' : undefined}
  aria-labelledby={agentDialogOpen ? undefined : 'workspace-note-title'}
  tabindex="-1"
>
  {#if agentDialogOpen}
    <div class="note-agent-view">
      <AskAgentDialog
        embedded
        close={() => void closeAgentView()}
        load={loadAgentAction}
        submit={submitAgentRequest}
        onSubmitted={handleAgentRequestSubmitted}
        onSubmittingChange={(value) => agentSubmitting = value}
      />
    </div>
  {:else}
    {#if panel}
      <WorkspacePanelHeader
        title="Note"
        titleId="workspace-note-title"
        close={() => void closeEditor()}
        closeLabel="Close workspace note"
      >
        {#snippet actions()}
          {@render askAgentAction()}
        {/snippet}
      </WorkspacePanelHeader>
    {:else}
      <header>
        <div>
          <h2 id="workspace-note-title">Note</h2>
        </div>
        <div class="note-header-actions">
          {@render askAgentAction()}
          <Button
            variant="ghost"
            size="sm"
            class="close-button"
            onclick={() => void closeEditor()}
            ariaLabel="Close workspace note"
          >
            <X size={17} strokeWidth={1.9} aria-hidden="true" />
          </Button>
        </div>
      </header>
    {/if}
    <form>
      {#if noteLoading}
        <p class="note-loading" role="status">Loading note…</p>
      {:else if !noteLoaded}
        <p class="note-error" role="alert">{noteLoadError}</p>
        <Button class="note-retry" size="sm" variant="secondary" onclick={() => void loadNote()}>Retry</Button>
      {:else}
        <Textarea
          bind:element={textarea}
          bind:value={draft}
          class="note-textarea"
          oninput={scheduleSave}
          onkeydown={handleEditorKeydown}
          placeholder="What is this workspace for? What changed? What comes next?"
          ariaLabel="Workspace note"
        />
        <div class="note-footer">
          <span class:error={Boolean(saveError)} class="note-save-status" role={saveError ? 'alert' : 'status'}
            >{saveStatus}</span
          >
        </div>
        {#if saveError}
          <p class="note-error" role="alert">{saveError}</p>
        {/if}
        {#if !askAgentAvailable}
          <p class="note-agent-hint">Start a foreground process in the main terminal to use Ask agent.</p>
        {/if}
        {#if agentUpdateMessage}
          <p class="note-agent-status" role="status">{agentUpdateMessage}</p>
        {/if}
      {/if}
    </form>
  {/if}
</section>

<style>
.note-editor {
  position: relative;
  display: grid;
  gap: 0.9rem;
  width: 100%;
  box-sizing: border-box;
  padding: 1rem;
  border: 1px solid var(--color-border-strong);
  border-radius: 0.8rem;
  background: var(--color-surface-overlay);
  box-shadow: var(--shadow-popover);
}
.note-editor.panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}
.note-editor.panel > form {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 0;
  gap: 0.65rem;
  padding: 1rem;
}
.note-agent-view {
  min-width: 0;
  min-height: 0;
  overflow: auto;
  padding: 1rem;
}
header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
}
h2 {
  margin: 0;
  font-size: var(--text-title);
  font-weight: var(--weight-strong);
  line-height: var(--leading-tight);
}
:global(.close-button) {
  flex: 0 0 auto;
  width: 2rem;
  min-width: 2rem;
  height: 2rem;
  padding: 0;
}
form {
  display: grid;
  gap: 0.65rem;
}
.note-loading {
  margin: 0;
  color: var(--color-text-secondary);
  font-size: var(--text-body);
  line-height: var(--leading-body);
}
:global(.note-retry) {
  justify-self: start;
}
:global(.note-textarea) {
  min-height: 8.5rem;
}
:global(.note-editor.panel .note-textarea) {
  flex: 1 1 auto;
  min-height: 0;
}
.note-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}
.note-footer > span {
  color: var(--color-text-tertiary);
  font-size: var(--text-caption);
  font-variant-numeric: tabular-nums;
}
.note-save-status {
  color: var(--color-text-tertiary);
}
.note-save-status.error {
  color: var(--color-danger-text);
}
.note-error {
  margin: 0;
  color: var(--color-danger-text);
  font-size: var(--text-label);
  line-height: var(--leading-ui);
}
.note-header-actions {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  flex: 0 0 auto;
}
.note-agent-hint,
.note-agent-status {
  margin: 0;
  color: var(--color-text-tertiary);
  font-size: var(--text-caption);
  line-height: var(--leading-ui);
}
.note-agent-status {
  color: var(--color-command);
}
</style>
