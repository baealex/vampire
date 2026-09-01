<script lang="ts">
import Send from '@lucide/svelte/icons/send';
import ImagePlus from '@lucide/svelte/icons/image-plus';
import History from '@lucide/svelte/icons/history';
import X from '@lucide/svelte/icons/x';
import { onDestroy, onMount } from 'svelte';
import {
  parseWorkspaceEntryDragEntries,
  WORKSPACE_ENTRY_DRAG_TYPE,
  workspaceEntryDragText,
} from '~/lib/shared/lib/workspace-entry-drag.ts';
import { terminalInputPreferences } from '../model/input-preferences.svelte.ts';
import type {
  WorkspaceComposerPrompt,
  WorkspaceComposerPromptPreview,
} from '~/lib/shared/contracts/workspace-composer-history.ts';

let {
  workspaceId,
  terminalId,
  connected,
  send,
  submit,
  composerHistoryEnabled = true,
  promptPreview = null,
  onSubmitted,
  loadPrompts,
  onImageSelected,
  scrollPageUp,
  scrollPageDown,
  scrollToTop,
  scrollToBottom,
  fontSize,
  minimumFontSize,
  maximumFontSize,
  decreaseFontSize,
  increaseFontSize,
  handoffToTerminal,
  onComposerFocus = () => undefined,
  composerElement = $bindable(),
}: {
  workspaceId: string;
  terminalId?: string;
  connected: boolean;
  send: (data: string) => void;
  submit: (data: string) => boolean;
  composerHistoryEnabled?: boolean;
  promptPreview?: WorkspaceComposerPromptPreview | null;
  onSubmitted: (prompt: string) => Promise<void>;
  loadPrompts: (refresh?: boolean) => Promise<WorkspaceComposerPrompt[]>;
  onImageSelected: (image: File) => void;
  scrollPageUp: () => void;
  scrollPageDown: () => void;
  scrollToTop: () => void;
  scrollToBottom: () => void;
  fontSize: number;
  minimumFontSize: number;
  maximumFontSize: number;
  decreaseFontSize: () => void;
  increaseFontSize: () => void;
  handoffToTerminal: (data: string) => void;
  onComposerFocus?: () => void;
  composerElement?: HTMLTextAreaElement;
} = $props();

let imageInputElement: HTMLInputElement;
let composerMessage = $state('');
let composerDropActive = $state(false);
let composerResizeFrame: number | undefined;
let draftStorageKey = '';
let draftStorageReady = false;
let draftPersistenceFailed = $state(false);

const COMPOSER_DRAFT_STORAGE_PREFIX = 'vampire:terminal-composer-draft:v1';

function composerDraftStorageKey(workspace: string, terminal?: string): string {
  return `${COMPOSER_DRAFT_STORAGE_PREFIX}:${encodeURIComponent(workspace)}:${encodeURIComponent(terminal ?? 'main')}`;
}

function persistComposerDraft(value = composerMessage) {
  if (!draftStorageReady) return;
  try {
    if (value) window.localStorage.setItem(draftStorageKey, value);
    else window.localStorage.removeItem(draftStorageKey);
    draftPersistenceFailed = false;
  } catch {
    draftPersistenceFailed = true;
  }
}

function updateComposerMessage(value: string) {
  composerMessage = value;
  persistComposerDraft(value);
}

onMount(() => {
  draftStorageKey = composerDraftStorageKey(workspaceId, terminalId);
  draftStorageReady = true;
  try {
    composerMessage = window.localStorage.getItem(draftStorageKey) ?? '';
  } catch {
    draftPersistenceFailed = true;
  }
  requestAnimationFrame(resizeComposer);
});
let promptHistoryOpen = $state(false);
let promptHistoryLoading = $state(false);
let promptHistoryError = $state('');
let promptHistory = $state<WorkspaceComposerPrompt[]>([]);
let promptHistoryLoaded = false;
let promptSaveError = $state('');

onDestroy(() => {
  persistComposerDraft();
  if (composerResizeFrame !== undefined) cancelAnimationFrame(composerResizeFrame);
});

function preventButtonFocus(event: PointerEvent) {
  event.preventDefault();
}

function sendControl(data: string) {
  send(data);
}

function sendComposerMessage() {
  if (!connected || !composerMessage.trim()) return;
  const submittedPrompt = composerMessage;
  if (!submit(submittedPrompt)) return;
  updateComposerMessage('');
  if (!composerHistoryEnabled) {
    requestAnimationFrame(() => {
      resizeComposer();
      composerElement?.focus();
    });
    return;
  }
  promptSaveError = '';
  void onSubmitted(submittedPrompt)
    .then(async () => {
      if (!promptHistoryOpen) return;
      promptHistory = await loadPrompts(true);
      promptHistoryLoaded = true;
    })
    .catch((error) => {
      promptSaveError = error instanceof Error ? error.message : 'Vampire could not save this prompt to history.';
    });
  requestAnimationFrame(() => {
    resizeComposer();
    composerElement?.focus();
  });
}

async function openPromptHistory() {
  promptHistoryOpen = true;
  if (promptHistoryLoaded || promptHistoryLoading) return;
  promptHistoryLoading = true;
  promptHistoryError = '';
  try {
    promptHistory = await loadPrompts();
    promptHistoryLoaded = true;
  } catch (error) {
    promptHistoryError = error instanceof Error ? error.message : 'Unable to load Composer history.';
  } finally {
    promptHistoryLoading = false;
  }
}

function closePromptHistory() {
  promptHistoryOpen = false;
  requestAnimationFrame(() => composerElement?.focus());
}

function insertComposerPrompt(prompt: string) {
  const start = composerElement?.selectionStart ?? composerMessage.length;
  const end = composerElement?.selectionEnd ?? start;
  updateComposerMessage(`${composerMessage.slice(0, start)}${prompt}${composerMessage.slice(end)}`);
  const caretPosition = start + prompt.length;
  promptHistoryOpen = false;
  requestAnimationFrame(() => {
    composerElement?.focus();
    composerElement?.setSelectionRange(caretPosition, caretPosition);
    resizeComposer();
  });
}

function formatPromptTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function resizeComposer() {
  if (!composerElement || composerResizeFrame !== undefined) return;
  composerResizeFrame = requestAnimationFrame(() => {
    composerResizeFrame = undefined;
    if (!composerElement) return;
    composerElement.style.height = 'auto';
    const nextHeight = Math.min(composerElement.scrollHeight, 128);
    composerElement.style.height = `${nextHeight}px`;
  });
}

function hasWorkspaceEntry(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes(WORKSPACE_ENTRY_DRAG_TYPE);
}

function handleComposerDragOver(event: DragEvent) {
  if (!connected || !event.dataTransfer || !hasWorkspaceEntry(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
  composerDropActive = true;
}

function handleComposerDragLeave() {
  composerDropActive = false;
}

function handleComposerDrop(event: DragEvent) {
  composerDropActive = false;
  if (!connected) return;
  const raw = event.dataTransfer?.getData(WORKSPACE_ENTRY_DRAG_TYPE);
  const entries = raw ? parseWorkspaceEntryDragEntries(raw) : undefined;
  if (!entries?.length) return;
  event.preventDefault();
  const insertion = entries.map(workspaceEntryDragText).join(' ');
  const start = composerElement?.selectionStart ?? composerMessage.length;
  const end = composerElement?.selectionEnd ?? start;
  updateComposerMessage(`${composerMessage.slice(0, start)}${insertion}${composerMessage.slice(end)}`);
  const caretPosition = start + insertion.length;
  requestAnimationFrame(() => {
    composerElement?.focus();
    composerElement?.setSelectionRange(caretPosition, caretPosition);
    resizeComposer();
  });
}

function handleComposerInput(event: Event) {
  updateComposerMessage((event.currentTarget as HTMLTextAreaElement).value);
  resizeComposer();
}

function shouldHandoffSlash(data: string | null): boolean {
  return (
    terminalInputPreferences.slashHandoff &&
    data === '/' &&
    composerMessage.length === 0 &&
    (composerElement?.selectionStart ?? 0) === 0 &&
    (composerElement?.selectionEnd ?? 0) === 0
  );
}

function handleComposerBeforeInput(event: InputEvent) {
  if (event.isComposing || event.inputType !== 'insertText' || !shouldHandoffSlash(event.data)) return;
  event.preventDefault();
  handoffToTerminal('/');
}

function insertComposerLineBreak() {
  const start = composerElement?.selectionStart ?? composerMessage.length;
  const end = composerElement?.selectionEnd ?? start;
  updateComposerMessage(composerMessage.slice(0, start) + '\n' + composerMessage.slice(end));
  requestAnimationFrame(() => {
    composerElement?.setSelectionRange(start + 1, start + 1);
    resizeComposer();
  });
}

function handleComposerKeydown(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229) return;
  if (!event.ctrlKey && !event.metaKey && !event.altKey && shouldHandoffSlash(event.key)) {
    event.preventDefault();
    handoffToTerminal('/');
    return;
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    if (event.shiftKey) insertComposerLineBreak();
    else sendComposerMessage();
  }
}

function handleImageSelection(event: Event) {
  const input = event.currentTarget as HTMLInputElement;
  const image = input.files?.[0];
  if (image) onImageSelected(image);
  input.value = '';
}
</script>

<div class="input-dock" class:compose-first={terminalInputPreferences.mode === 'compose'}>
  <div class="touch-toolbar" role="group" aria-label="Terminal controls">
    <button
      type="button"
      disabled={!connected}
      onpointerdown={preventButtonFocus}
      onclick={() => sendControl('\u001b')}
    >
      Esc
    </button>
    <button
      type="button"
      class="wide-key"
      disabled={!connected}
      onpointerdown={preventButtonFocus}
      onclick={() => sendControl('\u0003')}
    >
      Ctrl+C
    </button>
    <button type="button" disabled={!connected} onpointerdown={preventButtonFocus} onclick={() => sendControl('\t')}>
      Tab
    </button>
    <button
      type="button"
      class="wide-key"
      disabled={!connected}
      onpointerdown={preventButtonFocus}
      onclick={() => sendControl('\r')}
    >
      Enter
    </button>
    <span class="toolbar-divider" aria-hidden="true"></span>
    <button
      type="button"
      disabled={!connected}
      aria-label="Arrow up"
      onpointerdown={preventButtonFocus}
      onclick={() => sendControl('\u001b[A')}
    >
      ↑
    </button>
    <button
      type="button"
      disabled={!connected}
      aria-label="Arrow down"
      onpointerdown={preventButtonFocus}
      onclick={() => sendControl('\u001b[B')}
    >
      ↓
    </button>
    <button
      type="button"
      disabled={!connected}
      aria-label="Arrow left"
      onpointerdown={preventButtonFocus}
      onclick={() => sendControl('\u001b[D')}
    >
      ←
    </button>
    <button
      type="button"
      disabled={!connected}
      aria-label="Arrow right"
      onpointerdown={preventButtonFocus}
      onclick={() => sendControl('\u001b[C')}
    >
      →
    </button>
    <span class="toolbar-divider" aria-hidden="true"></span>
    <button
      type="button"
      class="wide-key"
      aria-label="Scroll to terminal top"
      title="Scroll to top"
      onpointerdown={preventButtonFocus}
      onclick={scrollToTop}
    >
      Top
    </button>
    <button
      type="button"
      class="wide-key"
      aria-label="Scroll terminal up one page"
      title="Scroll up one page"
      onpointerdown={preventButtonFocus}
      onclick={scrollPageUp}
    >
      PgUp
    </button>
    <button
      type="button"
      class="wide-key"
      aria-label="Scroll terminal down one page"
      title="Scroll down one page"
      onpointerdown={preventButtonFocus}
      onclick={scrollPageDown}
    >
      PgDn
    </button>
    <button
      type="button"
      class="wide-key"
      aria-label="Scroll to terminal bottom"
      title="Scroll to bottom"
      onpointerdown={preventButtonFocus}
      onclick={scrollToBottom}
    >
      Bottom
    </button>
    <span class="toolbar-divider" aria-hidden="true"></span>
    <button
      type="button"
      aria-label="Decrease terminal text size"
      title={`Decrease text size (currently ${fontSize}px)`}
      disabled={fontSize <= minimumFontSize}
      onpointerdown={preventButtonFocus}
      onclick={decreaseFontSize}
    >
      A−
    </button>
    <button
      type="button"
      aria-label="Increase terminal text size"
      title={`Increase text size (currently ${fontSize}px)`}
      disabled={fontSize >= maximumFontSize}
      onpointerdown={preventButtonFocus}
      onclick={increaseFontSize}
    >
      A+
    </button>
  </div>
  {#if composerHistoryEnabled && promptHistoryOpen}
    <section class="prompt-history" id="composer-prompt-history" aria-label="Composer history">
      <header>
        <strong>Composer history</strong>
        <button type="button" onclick={closePromptHistory} aria-label="Close Composer history" title="Close history">
          <X size={17} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </header>
      {#if promptHistoryLoading}
        <p class="prompt-history-message" role="status">Loading history…</p>
      {:else if promptHistoryError}
        <p class="prompt-history-message error" role="alert">{promptHistoryError}</p>
      {:else if promptHistory.length === 0}
        <p class="prompt-history-message">Prompts sent from this Composer will appear here.</p>
      {:else}
        <div class="prompt-history-list">
          {#each promptHistory as prompt (prompt.id)}
            <button type="button" class="prompt-history-item" onclick={() => insertComposerPrompt(prompt.text)}>
              <span>{prompt.text}</span>
              <time datetime={new Date(prompt.submittedAt).toISOString()}
                >{formatPromptTimestamp(prompt.submittedAt)}</time
              >
            </button>
          {/each}
        </div>
      {/if}
    </section>
  {:else if composerHistoryEnabled && promptPreview}
    <button type="button" class="last-prompt" onclick={openPromptHistory} title={promptPreview.text}>
      <span class="last-prompt-label">Last sent</span>
      <span class="last-prompt-text">{promptPreview.text}</span>
    </button>
  {/if}
  {#if promptSaveError}
    <p class="prompt-save-error" role="alert">{promptSaveError}</p>
  {/if}
  <div
    class="composer"
    class:history-disabled={!composerHistoryEnabled}
    class:drop-target={composerDropActive}
    role="group"
    aria-label="Terminal input"
    ondragenter={handleComposerDragOver}
    ondragover={handleComposerDragOver}
    ondragleave={handleComposerDragLeave}
    ondrop={handleComposerDrop}
  >
    <label class="visually-hidden" for="shell-message">Send text to the shell</label>
    <input
      class="visually-hidden"
      bind:this={imageInputElement}
      type="file"
      accept="image/avif,image/gif,image/jpeg,image/png,image/webp"
      onchange={handleImageSelection}
      tabindex="-1"
    >
    <textarea
      id="shell-message"
      bind:this={composerElement}
      value={composerMessage}
      oninput={handleComposerInput}
      onbeforeinput={handleComposerBeforeInput}
      onkeydown={handleComposerKeydown}
      onfocus={onComposerFocus}
      rows="1"
      placeholder="Send to shell…"
      autocapitalize="off"
      autocomplete="off"
      spellcheck="false"
    ></textarea>
    {#if composerHistoryEnabled}
      <button
        class="history-button"
        type="button"
        onpointerdown={preventButtonFocus}
        onclick={() => promptHistoryOpen ? closePromptHistory() : void openPromptHistory()}
        aria-label={promptHistoryOpen ? 'Close Composer history' : 'Open Composer history'}
        aria-expanded={promptHistoryOpen}
        aria-controls="composer-prompt-history"
        title="Composer history"
      >
        <History size={18} strokeWidth={1.8} aria-hidden="true" />
      </button>
    {/if}
    <button
      class="image-button"
      type="button"
      onclick={() => imageInputElement?.click()}
      disabled={!connected}
      aria-label="Send an image to the shell"
      title="Send an image"
    >
      <ImagePlus size={18} strokeWidth={1.8} aria-hidden="true" />
    </button>
    <button
      class="send-button"
      type="button"
      onpointerdown={preventButtonFocus}
      onclick={sendComposerMessage}
      disabled={!connected || !composerMessage.trim()}
      aria-label="Send to shell"
      title="Send text and press Enter"
    >
      <Send size={19} strokeWidth={1.8} aria-hidden="true" />
    </button>
  </div>
  {#if draftPersistenceFailed}
    <p class="draft-persistence-error" role="status">This draft could not be saved in this browser.</p>
  {/if}
</div>

<style>
.input-dock {
  --dock-inline-start: max(0.55rem, env(safe-area-inset-left));
  --dock-inline-end: max(0.55rem, env(safe-area-inset-right));
  min-width: 0;
  border-top: 1px solid var(--color-border-subtle);
  background: var(--color-panel);
  box-shadow: var(--shadow-terminal-dock);
}
.touch-toolbar {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  min-width: 0;
  overflow-x: auto;
  padding: 0.35rem var(--dock-inline-end) 0.15rem var(--dock-inline-start);
  scrollbar-width: none;
}
.touch-toolbar::-webkit-scrollbar {
  display: none;
}
.touch-toolbar button {
  flex: 0 0 auto;
  width: auto;
  min-width: 2.5rem;
  height: 2.25rem;
  min-height: 2.25rem;
  padding: 0 0.65rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-control);
  background: var(--color-control-background);
  color: var(--color-text);
  font: inherit;
  font-size: var(--text-caption);
  font-weight: var(--weight-medium);
  cursor: pointer;
  touch-action: manipulation;
}
@media (hover: hover) {
  .touch-toolbar button:hover:not(:disabled) {
    background: var(--color-surface-hover);
  }
}
.touch-toolbar button:disabled {
  color: var(--color-text-disabled);
  cursor: default;
}
.touch-toolbar .wide-key {
  flex-basis: auto;
  width: auto;
  min-width: 3.75rem;
  padding-inline: 0.75rem;
}
.toolbar-divider {
  flex: 0 0 1px;
  width: 1px;
  height: 2.25rem;
  margin: 0 0.15rem;
  background: var(--color-border);
}
.composer {
  display: grid;
  grid-template-columns: minmax(0, 1fr) repeat(3, var(--control-height-md));
  align-items: center;
  gap: 0.2rem;
  min-width: 0;
  margin: 0.35rem var(--dock-inline-end) max(0.5rem, env(safe-area-inset-bottom)) var(--dock-inline-start);
  padding: 0.18rem;
  border: 1px solid var(--color-border);
  border-radius: 0.78rem;
  background: var(--color-control-background);
}
.composer.history-disabled {
  grid-template-columns: minmax(0, 1fr) repeat(2, var(--control-height-md));
}
.composer:focus-within {
  border-color: var(--color-accent);
  box-shadow: var(--shadow-accent-focus);
}
.composer.drop-target {
  border-color: var(--color-accent);
  background: var(--color-surface-active);
  box-shadow: var(--shadow-accent-focus);
}
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}
.composer textarea {
  width: 100%;
  min-width: 0;
  min-height: var(--control-height-md);
  max-height: 8rem;
  padding: 0.58rem 0.62rem;
  overflow-y: auto;
  resize: none;
  border: 0;
  border-radius: var(--radius-sm);
  outline: none;
  background: transparent;
  color: var(--color-text);
  font: inherit;
  font-size: 1rem;
  line-height: var(--leading-ui);
}
.composer textarea::placeholder {
  color: var(--color-field-placeholder);
}
.draft-persistence-error {
  margin: 0;
  padding: 0.15rem var(--dock-inline-end) 0.35rem var(--dock-inline-start);
  color: var(--color-danger-text);
  font-size: var(--text-caption);
}
.composer button {
  display: grid;
  place-items: center;
  width: var(--control-height-md);
  height: var(--control-height-md);
  padding: 0;
  border: 0;
  border-radius: 0.58rem;
  cursor: pointer;
  touch-action: manipulation;
}
.image-button {
  background: transparent;
  color: var(--color-text-secondary);
}
.history-button {
  background: transparent;
  color: var(--color-text-secondary);
}
@media (hover: hover) {
  .image-button:hover:not(:disabled),
  .history-button:hover:not(:disabled) {
    background: var(--color-surface-hover);
    color: var(--color-text);
  }
}
.last-prompt {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 0.45rem;
  width: calc(100% - var(--dock-inline-start) - var(--dock-inline-end));
  margin: 0.35rem var(--dock-inline-end) 0 var(--dock-inline-start);
  padding: 0.2rem 0.35rem;
  border: 0;
  background: transparent;
  color: var(--color-text-tertiary);
  font: inherit;
  font-size: var(--text-caption);
  text-align: left;
  cursor: pointer;
}
.last-prompt-label {
  color: var(--color-text-disabled);
}
.last-prompt-text {
  min-width: 0;
  overflow: hidden;
  color: var(--color-text-secondary);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.prompt-history {
  max-height: min(18rem, 42vh);
  margin: 0.45rem var(--dock-inline-end) 0 var(--dock-inline-start);
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-control);
  background: var(--color-surface-raised);
}
.prompt-history header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.5rem 0.6rem 0.4rem 0.75rem;
  border-bottom: 1px solid var(--color-border-subtle);
  font-size: var(--text-label);
}
.prompt-history header button {
  display: grid;
  place-items: center;
  width: var(--control-height-sm);
  height: var(--control-height-sm);
  padding: 0;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
}
.prompt-history-list {
  max-height: 14rem;
  overflow-y: auto;
}
.prompt-history-item {
  display: grid;
  gap: 0.25rem;
  width: 100%;
  padding: 0.6rem 0.75rem;
  border: 0;
  border-bottom: 1px solid var(--color-border-subtle);
  background: transparent;
  color: var(--color-text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.prompt-history-item:last-child {
  border-bottom: 0;
}
@media (hover: hover) {
  .prompt-history-item:hover,
  .prompt-history header button:hover,
  .last-prompt:hover {
    background: var(--color-surface-hover);
  }
}
.prompt-history-item span {
  display: -webkit-box;
  overflow: hidden;
  line-height: var(--leading-body);
  white-space: pre-wrap;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
}
.prompt-history-item time {
  color: var(--color-text-disabled);
  font-size: var(--text-micro);
}
.prompt-history-message,
.prompt-save-error {
  margin: 0;
  padding: 0.7rem 0.75rem;
  color: var(--color-text-secondary);
  font-size: var(--text-caption);
  line-height: var(--leading-ui);
}
.prompt-history-message.error,
.prompt-save-error {
  color: var(--color-danger);
}
.prompt-save-error {
  padding: 0.35rem var(--dock-inline-end) 0 var(--dock-inline-start);
}
.send-button {
  background: var(--color-accent);
  color: var(--color-accent-ink);
}
@media (hover: hover) {
  .send-button:hover:not(:disabled) {
    background: var(--color-accent-hover);
  }
}
.composer button:disabled {
  background: transparent;
  color: var(--color-text-disabled);
  cursor: default;
}

@media (any-pointer: fine) {
  .input-dock {
    --dock-inline-start: 0.75rem;
    --dock-inline-end: 0.75rem;
  }
  .input-dock:not(.compose-first) .touch-toolbar {
    display: none;
  }
  .input-dock.compose-first .touch-toolbar {
    padding: 0.4rem var(--dock-inline-end) 0 var(--dock-inline-start);
  }
  .input-dock.compose-first .touch-toolbar button {
    min-width: 2.25rem;
    height: 2rem;
    min-height: 2rem;
    padding-inline: 0.55rem;
  }
  .input-dock.compose-first .toolbar-divider {
    height: 1.65rem;
  }
  .composer {
    grid-template-columns: minmax(0, 1fr) repeat(3, var(--control-height-md));
    margin: 0.6rem var(--dock-inline-end) 0.7rem var(--dock-inline-start);
  }
  .composer textarea {
    font-size: var(--text-body);
  }
}
</style>
