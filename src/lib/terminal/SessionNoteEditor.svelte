<script lang="ts">
import { onDestroy, onMount, tick } from 'svelte';
import Sparkles from '@lucide/svelte/icons/sparkles';
import X from '@lucide/svelte/icons/x';

const AUTOSAVE_DELAY_MS = 700;
const AGENT_NOTE_REFRESH_MS = 2_000;

let {
  getNote,
  close,
  save,
  summarize,
  panel = false,
}: {
  getNote: (refresh?: boolean) => Promise<string>;
  close: () => void;
  save: (note: string) => Promise<void>;
  summarize: () => Promise<{ notePath: string }>;
  panel?: boolean;
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
let summarizing = $state(false);
let summaryQueued = $state(false);
let summaryMessage = $state('');
let summaryError = $state('');
let summaryTargetPath = $state('');
let refreshingAgentNote = false;
let destroyed = false;
let saveStatus = $derived(
  saving ? 'Saving…' : saveError ? 'Save failed' : draft === savedNote ? 'Saved' : 'Saving soon…'
);

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

async function closeEditor() {
  clearSaveTimer();
  if (!noteLoaded) {
    close();
    return;
  }
  await saveDraft();
  if (draft !== savedNote) return;
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
    if (summaryQueued) {
      summaryQueued = false;
      summaryMessage = 'The note changed. Live sync is on.';
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

async function summarizeNote() {
  if (!noteLoaded || summarizing || summaryQueued) return;
  clearSaveTimer();
  await saveDraft();
  if (draft !== savedNote) return;
  summarizing = true;
  summaryError = '';
  summaryMessage = '';
  try {
    const result = await summarize();
    summaryTargetPath = result.notePath;
    summaryQueued = true;
    summaryMessage = 'Queued — waiting for the agent to update the note.';
    startAgentNoteSync();
  } catch (error) {
    summaryError = error instanceof Error ? error.message : 'The note update could not be queued.';
  } finally {
    summarizing = false;
  }
}

function handleKeydown(event: KeyboardEvent) {
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
  destroyed = true;
  clearSaveTimer();
  stopAgentNoteSync();
});
</script>

<div
  class="note-editor"
  class:panel
  role="dialog"
  aria-labelledby="workspace-note-title"
  tabindex="-1"
  onkeydown={handleKeydown}
>
  <header>
    <div>
      <h2 id="workspace-note-title">Workspace note</h2>
      <p>Keep the next step here.</p>
    </div>
    <button type="button" class="close-button" onclick={() => void closeEditor()} aria-label="Close workspace note">
      <X size={17} strokeWidth={1.9} aria-hidden="true" />
    </button>
  </header>
  <form>
    {#if noteLoading}
      <p class="note-loading" role="status">Loading note…</p>
    {:else if !noteLoaded}
      <p class="note-error" role="alert">{noteLoadError}</p>
      <button type="button" class="retry-button" onclick={() => void loadNote()}>Retry</button>
    {:else}
      <textarea
        bind:this={textarea}
        bind:value={draft}
        oninput={scheduleSave}
        placeholder="What is this workspace for? What changed? What comes next?"
        aria-label="Workspace note"
      ></textarea>
      <div class="note-footer">
        <span class:error={Boolean(saveError)} class="note-save-status" role={saveError ? 'alert' : 'status'}
          >{saveStatus}</span
        >
      </div>
      {#if saveError}
        <p class="note-error" role="alert">{saveError}</p>
      {/if}
      <div class="agent-note-action">
        <button
          type="button"
          onclick={() => void summarizeNote()}
          disabled={summarizing || summaryQueued || Boolean(saveError)}
        >
          <Sparkles size={16} strokeWidth={1.8} aria-hidden="true" />
          {summarizing ? 'Queuing…' : summaryQueued ? 'Waiting for note update' : 'Summarize with agent'}
        </button>
        <p>Ask the agent to update this note.</p>
      </div>
      {#if summaryMessage}
        <p class="note-agent-status" role="status">{summaryMessage}</p>
      {/if}
      {#if summaryTargetPath}
        <p class="note-agent-target">Note file: <code>{summaryTargetPath}</code></p>
      {/if}
      {#if summaryError}
        <p class="note-error" role="alert">{summaryError}</p>
      {/if}
    {/if}
  </form>
</div>

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
  align-content: start;
  min-height: 100%;
  padding: 1rem;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
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
header p {
  margin: 0.25rem 0 0;
  color: var(--color-text-tertiary);
  font-size: var(--text-caption);
  line-height: var(--leading-ui);
}
.close-button {
  display: grid;
  flex: 0 0 auto;
  place-items: center;
  width: 2rem;
  height: 2rem;
  padding: 0;
  border: 0;
  border-radius: 0.42rem;
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
}
.close-button:hover {
  background: var(--color-control-hover);
  color: var(--color-text);
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
.retry-button {
  justify-self: start;
  padding: 0.45rem 0.7rem;
  border: 1px solid var(--color-border);
  border-radius: 0.45rem;
  background: var(--color-control-background);
  color: var(--color-text);
  font: inherit;
  cursor: pointer;
}
.retry-button:hover {
  background: var(--color-control-hover);
}
textarea {
  width: 100%;
  min-height: 8.5rem;
  resize: vertical;
  padding: 0.75rem;
  border: 1px solid var(--color-border);
  border-radius: 0.55rem;
  outline: none;
  background: var(--color-field-background);
  color: var(--color-text);
  font: inherit;
  font-size: var(--text-body);
  line-height: var(--leading-body);
}
textarea::placeholder {
  color: var(--color-field-placeholder);
}
textarea:focus {
  border-color: var(--color-accent);
  box-shadow: var(--shadow-accent-focus);
}
.note-editor.panel textarea {
  min-height: min(24rem, 42vh);
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
.agent-note-action {
  display: grid;
  gap: 0.38rem;
  padding-top: 0.2rem;
  border-top: 1px solid var(--color-border-subtle);
}
.agent-note-action button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.42rem;
  min-height: 2.45rem;
  padding: 0 0.78rem;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-control);
  background: var(--color-control-background);
  color: var(--color-text);
  font: inherit;
  font-size: var(--text-label);
  font-weight: var(--weight-medium);
  cursor: pointer;
}
.agent-note-action button:hover:not(:disabled) {
  background: var(--color-control-hover);
}
.agent-note-action button:disabled {
  color: var(--color-text-disabled);
  cursor: wait;
}
.agent-note-action p,
.note-agent-status {
  margin: 0;
  color: var(--color-text-tertiary);
  font-size: var(--text-caption);
  line-height: var(--leading-ui);
}
.note-agent-status {
  color: var(--color-command);
}
.note-agent-target {
  margin: 0;
  overflow-wrap: anywhere;
  color: var(--color-text-tertiary);
  font-size: var(--text-caption);
  line-height: var(--leading-ui);
}
.note-agent-target code {
  color: var(--color-text-secondary);
  font-family: var(--font-mono);
}

@media (max-width: 32rem) {
  textarea {
    min-height: 7.5rem;
    font-size: 1rem;
  }
}
</style>
