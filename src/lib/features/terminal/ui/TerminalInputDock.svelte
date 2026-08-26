<script lang="ts">
import Send from '@lucide/svelte/icons/send';
import ImagePlus from '@lucide/svelte/icons/image-plus';
import {
  parseWorkspaceEntryDrag,
  WORKSPACE_ENTRY_DRAG_TYPE,
  workspaceEntryDragText,
} from '~/lib/shared/lib/workspace-entry-drag.ts';

let {
  connected,
  send,
  submit,
  onComposerFocusChange,
  onImageSelected,
  scrollToTop,
  scrollToBottom,
  fontSize,
  minimumFontSize,
  maximumFontSize,
  decreaseFontSize,
  increaseFontSize,
}: {
  connected: boolean;
  send: (data: string) => void;
  submit: (data: string) => boolean;
  onComposerFocusChange: (focused: boolean) => void;
  onImageSelected: (image: File) => void;
  scrollToTop: () => void;
  scrollToBottom: () => void;
  fontSize: number;
  minimumFontSize: number;
  maximumFontSize: number;
  decreaseFontSize: () => void;
  increaseFontSize: () => void;
} = $props();

let composerElement: HTMLTextAreaElement;
let imageInputElement: HTMLInputElement;
let composerMessage = $state('');
let composerDropActive = $state(false);

function preventButtonFocus(event: PointerEvent) {
  event.preventDefault();
}

function sendControl(data: string) {
  send(data);
}

function sendComposerMessage() {
  if (!connected || !composerMessage.trim()) return;
  if (!submit(composerMessage)) return;
  composerMessage = '';
  requestAnimationFrame(() => {
    resizeComposer();
    composerElement?.focus();
  });
}

function resizeComposer() {
  if (!composerElement) return;
  composerElement.style.height = 'auto';
  composerElement.style.height = `${Math.min(composerElement.scrollHeight, 128)}px`;
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
  const entry = raw ? parseWorkspaceEntryDrag(raw) : undefined;
  if (!entry) return;
  event.preventDefault();
  const insertion = workspaceEntryDragText(entry);
  const start = composerElement.selectionStart ?? composerMessage.length;
  const end = composerElement.selectionEnd ?? start;
  composerMessage = `${composerMessage.slice(0, start)}${insertion}${composerMessage.slice(end)}`;
  const caretPosition = start + insertion.length;
  requestAnimationFrame(() => {
    composerElement?.focus();
    composerElement?.setSelectionRange(caretPosition, caretPosition);
    resizeComposer();
  });
}

function handleComposerKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendComposerMessage();
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
  <div class="touch-toolbar" aria-label="Terminal controls">
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
  <div
    class="composer"
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
      bind:value={composerMessage}
      oninput={resizeComposer}
      onkeydown={handleComposerKeydown}
      onfocus={() => onComposerFocusChange(true)}
      onblur={() => onComposerFocusChange(false)}
      rows="1"
      placeholder="Send to shell…"
      autocapitalize="off"
      autocomplete="off"
      spellcheck="false"
      disabled={!connected}
    ></textarea>
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
  padding: 0.45rem var(--dock-inline-end) 0.25rem var(--dock-inline-start);
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
  grid-template-columns: minmax(0, 1fr) var(--control-height-md) var(--control-height-md);
  align-items: center;
  gap: 0.2rem;
  min-width: 0;
  margin: 0.35rem var(--dock-inline-end) max(0.5rem, env(safe-area-inset-bottom)) var(--dock-inline-start);
  padding: 0.18rem;
  border: 1px solid var(--color-border);
  border-radius: 0.78rem;
  background: var(--color-control-background);
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
@media (hover: hover) {
  .image-button:hover:not(:disabled) {
    background: var(--color-surface-hover);
    color: var(--color-text);
  }
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

@media (min-width: 64rem) {
  .input-dock {
    --dock-inline-start: 0.75rem;
    --dock-inline-end: 0.75rem;
  }
  .touch-toolbar {
    display: none;
  }
  .composer {
    grid-template-columns: minmax(0, 1fr) var(--control-height-md) var(--control-height-md);
    margin: 0.6rem var(--dock-inline-end) 0.7rem var(--dock-inline-start);
  }
  .composer textarea {
    font-size: var(--text-body);
  }
}
</style>
