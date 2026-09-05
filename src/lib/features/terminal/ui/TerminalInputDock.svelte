<script lang="ts">
import Send from '@lucide/svelte/icons/send';
import ImagePlus from '@lucide/svelte/icons/image-plus';
import History from '@lucide/svelte/icons/history';
import { onDestroy, onMount } from 'svelte';
import DialogShell from '~/lib/shared/ui/DialogShell.svelte';
import {
  parseWorkspaceEntryDragEntries,
  WORKSPACE_ENTRY_DRAG_TYPE,
  workspaceEntryDragText,
} from '~/lib/shared/lib/workspace-entry-drag.ts';
import { loadComposerDraft, saveComposerDraft } from '../model/composer-draft-storage.ts';
import type { TerminalControlKey } from '../model/terminal-control.ts';
import { renderComposerTemplate, type ComposerTemplateContext } from '~/lib/shared/lib/composer-template.ts';
import type { WorkspaceComposerPrompt } from '~/lib/shared/contracts/workspace-composer-history.ts';

let {
  workspaceId,
  terminalId,
  connected,
  composerTemplate,
  composerTemplateContext,
  sendControl,
  submit,
  composerHistoryEnabled = true,
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
  composerTemplate?: string;
  composerTemplateContext: ComposerTemplateContext;
  sendControl: (control: TerminalControlKey) => void;
  submit: (data: string) => boolean;
  composerHistoryEnabled?: boolean;
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
let draftStorageReady = false;
let draftPersistenceFailed = $state(false);
let terminalControlFocusTarget: HTMLElement | undefined;

function persistComposerDraft(value = composerMessage) {
  if (!draftStorageReady) return;
  draftPersistenceFailed = !saveComposerDraft(workspaceId, terminalId, value);
}

function updateComposerMessage(value: string) {
  composerMessage = value;
  persistComposerDraft(value);
}

onMount(() => {
  draftStorageReady = true;
  const restoredDraft = loadComposerDraft(workspaceId, terminalId);
  composerMessage = restoredDraft.value;
  draftPersistenceFailed = !restoredDraft.available;
  requestAnimationFrame(resizeComposer);
});
let promptHistoryOpen = $state(false);
let promptHistoryLoading = $state(false);
let promptHistoryError = $state('');
let promptHistory = $state<WorkspaceComposerPrompt[]>([]);
let promptHistoryLoaded = false;
let promptSaveError = $state('');
let composerTemplateWarning = $state('');

onDestroy(() => {
  persistComposerDraft();
  if (composerResizeFrame !== undefined) cancelAnimationFrame(composerResizeFrame);
});

function preventButtonFocus(event: PointerEvent) {
  event.preventDefault();
}

function prepareTerminalControl(event: PointerEvent) {
  event.preventDefault();
  const focusTarget = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  terminalControlFocusTarget = focusTarget;
  if (!focusTarget) return;
  requestAnimationFrame(() => {
    if (terminalControlFocusTarget === focusTarget) restoreTerminalControlFocus();
  });
}

function restoreTerminalControlFocus() {
  const focusTarget = terminalControlFocusTarget;
  terminalControlFocusTarget = undefined;
  if (focusTarget?.isConnected) focusTarget.focus({ preventScroll: true });
}

function sendTerminalControl(control: TerminalControlKey) {
  sendControl(control);
  restoreTerminalControlFocus();
}

function runTerminalControl(action: () => void) {
  action();
  restoreTerminalControlFocus();
}

function sendComposerMessage() {
  if (!connected) return;
  if (!composerMessage.trim()) {
    if (composerMessage) updateComposerMessage('');
    sendTerminalControl('enter');
    requestAnimationFrame(resizeComposer);
    return;
  }
  const submittedPrompt = composerMessage;
  const rendered = renderComposerTemplate(composerTemplate, submittedPrompt, composerTemplateContext);
  if (!submit(rendered.text)) return;
  composerTemplateWarning = rendered.error
    ? `The Compose template could not be applied, so the original message was sent. ${rendered.error}`
    : '';
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
  if (!composerMessage && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
    const terminalControl = (
      {
        Escape: 'escape',
        ArrowUp: 'arrow-up',
        ArrowDown: 'arrow-down',
        ArrowLeft: 'arrow-left',
        ArrowRight: 'arrow-right',
      } satisfies Record<string, TerminalControlKey>
    )[event.key];
    if (terminalControl) {
      event.preventDefault();
      sendTerminalControl(terminalControl);
      return;
    }
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

<div class="input-dock">
  <div class="touch-toolbar" role="group" aria-label="Terminal controls">
    <button
      type="button"
      disabled={!connected}
      onpointerdown={prepareTerminalControl}
      onclick={() => sendTerminalControl('escape')}
    >
      Esc
    </button>
    <button
      type="button"
      class="wide-key"
      disabled={!connected}
      onpointerdown={prepareTerminalControl}
      onclick={() => sendTerminalControl('interrupt')}
    >
      Ctrl+C
    </button>
    <button
      type="button"
      disabled={!connected}
      onpointerdown={prepareTerminalControl}
      onclick={() => sendTerminalControl('tab')}
    >
      Tab
    </button>
    <button
      type="button"
      class="wide-key"
      disabled={!connected}
      onpointerdown={prepareTerminalControl}
      onclick={() => sendTerminalControl('backspace')}
    >
      Backspace
    </button>
    <button
      type="button"
      class="wide-key"
      disabled={!connected}
      onpointerdown={prepareTerminalControl}
      onclick={() => sendTerminalControl('enter')}
    >
      Enter
    </button>
    <span class="toolbar-divider" aria-hidden="true"></span>
    <button
      type="button"
      disabled={!connected}
      aria-label="Arrow up"
      onpointerdown={prepareTerminalControl}
      onclick={() => sendTerminalControl('arrow-up')}
    >
      ↑
    </button>
    <button
      type="button"
      disabled={!connected}
      aria-label="Arrow down"
      onpointerdown={prepareTerminalControl}
      onclick={() => sendTerminalControl('arrow-down')}
    >
      ↓
    </button>
    <button
      type="button"
      disabled={!connected}
      aria-label="Arrow left"
      onpointerdown={prepareTerminalControl}
      onclick={() => sendTerminalControl('arrow-left')}
    >
      ←
    </button>
    <button
      type="button"
      disabled={!connected}
      aria-label="Arrow right"
      onpointerdown={prepareTerminalControl}
      onclick={() => sendTerminalControl('arrow-right')}
    >
      →
    </button>
    <span class="toolbar-divider" aria-hidden="true"></span>
    <button
      type="button"
      class="wide-key"
      aria-label="Scroll to terminal top"
      title="Scroll to top"
      onpointerdown={prepareTerminalControl}
      onclick={() => runTerminalControl(scrollToTop)}
    >
      Top
    </button>
    <button
      type="button"
      class="wide-key"
      aria-label="Scroll terminal up one page"
      title="Scroll up one page"
      onpointerdown={prepareTerminalControl}
      onclick={() => runTerminalControl(scrollPageUp)}
    >
      PgUp
    </button>
    <button
      type="button"
      class="wide-key"
      aria-label="Scroll terminal down one page"
      title="Scroll down one page"
      onpointerdown={prepareTerminalControl}
      onclick={() => runTerminalControl(scrollPageDown)}
    >
      PgDn
    </button>
    <button
      type="button"
      class="wide-key"
      aria-label="Scroll to terminal bottom"
      title="Scroll to bottom"
      onpointerdown={prepareTerminalControl}
      onclick={() => runTerminalControl(scrollToBottom)}
    >
      Bottom
    </button>
    <span class="toolbar-divider" aria-hidden="true"></span>
    <button
      type="button"
      aria-label="Decrease terminal text size"
      title={`Decrease text size (currently ${fontSize}px)`}
      disabled={fontSize <= minimumFontSize}
      onpointerdown={prepareTerminalControl}
      onclick={() => runTerminalControl(decreaseFontSize)}
    >
      A−
    </button>
    <button
      type="button"
      aria-label="Increase terminal text size"
      title={`Increase text size (currently ${fontSize}px)`}
      disabled={fontSize >= maximumFontSize}
      onpointerdown={prepareTerminalControl}
      onclick={() => runTerminalControl(increaseFontSize)}
    >
      A+
    </button>
  </div>
  {#if composerHistoryEnabled && promptHistoryOpen}
    <DialogShell
      title="Composer history"
      close={closePromptHistory}
      closeLabel="Close Composer history"
      contentId="composer-prompt-history"
    >
      {#snippet children()}
        <section class="prompt-history" aria-label="Composer history">
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
      {/snippet}
    </DialogShell>
  {/if}
  {#if promptSaveError}
    <p class="prompt-save-error" role="alert">{promptSaveError}</p>
  {/if}
  {#if composerTemplateWarning}
    <p class="composer-send-warning" role="status">{composerTemplateWarning}</p>
  {/if}
  <div class="composer-slot">
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
        placeholder="Compose a message…"
        title="Focus from the terminal with Command+/"
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
  </div>
  {#if draftPersistenceFailed}
    <p class="draft-persistence-error" role="status">This draft could not be saved in this browser.</p>
  {/if}
</div>

<style>
.input-dock {
  --dock-inline-start: max(0.55rem, env(safe-area-inset-left));
  --dock-inline-end: max(0.55rem, env(safe-area-inset-right));
  --composer-control-size: 2.5rem;
  min-width: 0;
  position: relative;
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
.composer-slot {
  position: relative;
  height: calc(var(--composer-control-size) + 0.36rem + 2px);
  margin: 0.35rem var(--dock-inline-end) max(0.5rem, env(safe-area-inset-bottom)) var(--dock-inline-start);
}
.composer {
  position: absolute;
  z-index: 4;
  right: 0;
  bottom: 0;
  left: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) repeat(3, var(--composer-control-size));
  align-items: end;
  gap: 0.35rem;
  min-width: 0;
  padding: 0.18rem;
  border: 1px solid var(--color-border);
  border-radius: 0.78rem;
  background: var(--color-control-background);
}
.composer.history-disabled {
  grid-template-columns: minmax(0, 1fr) repeat(2, var(--composer-control-size));
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
  min-height: var(--composer-control-size);
  max-height: 8rem;
  padding: 0.52rem 0.62rem;
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
  width: var(--composer-control-size);
  height: var(--composer-control-size);
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
.prompt-history {
  min-width: 0;
}
.prompt-history-list {
  max-height: min(24rem, 55dvh);
  overflow-y: auto;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-control);
  background: var(--color-surface-raised);
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
  .prompt-history-item:hover {
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
.prompt-save-error,
.composer-send-warning {
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
.composer-send-warning {
  padding: 0.35rem var(--dock-inline-end) 0 var(--dock-inline-start);
  color: var(--color-warning-text, var(--color-text-secondary));
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
  .touch-toolbar {
    padding: 0.4rem var(--dock-inline-end) 0 var(--dock-inline-start);
  }
  .touch-toolbar button {
    min-width: 2.25rem;
    height: 2rem;
    min-height: 2rem;
    padding-inline: 0.55rem;
  }
  .toolbar-divider {
    height: 1.65rem;
  }
  .composer {
    grid-template-columns: minmax(0, 1fr) repeat(3, var(--composer-control-size));
    gap: 0.2rem;
  }
  .composer-slot {
    margin: 0.6rem var(--dock-inline-end) 0.7rem var(--dock-inline-start);
  }
  .composer textarea {
    font-size: var(--text-body);
  }
}
</style>
