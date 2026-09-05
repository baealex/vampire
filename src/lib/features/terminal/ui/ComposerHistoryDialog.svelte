<script lang="ts">
import History from '@lucide/svelte/icons/history';
import { onDestroy, tick } from 'svelte';
import type { WorkspaceComposerPrompt } from '~/lib/shared/contracts/workspace-composer-history.ts';
import PopoverShell from '~/lib/shared/ui/PopoverShell.svelte';

let {
  open,
  prompts,
  loading,
  error,
  requestOpen,
  close,
  dismissOutside,
  select,
}: {
  open: boolean;
  prompts: WorkspaceComposerPrompt[];
  loading: boolean;
  error: string;
  requestOpen: () => void;
  close: () => void;
  dismissOutside: () => void;
  select: (prompt: string) => void;
} = $props();

let query = $state('');
let selectedIndex = $state(0);
let searchElement = $state<HTMLInputElement>();
let disposed = false;
let closingFromOutside = false;
const filteredPrompts = $derived.by(() => {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return prompts;
  return prompts.filter((prompt) => prompt.text.toLocaleLowerCase().includes(normalizedQuery));
});

$effect(() => {
  if (selectedIndex >= filteredPrompts.length) selectedIndex = Math.max(0, filteredPrompts.length - 1);
});

function formatPromptTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function scrollSelectedPromptIntoView() {
  void tick().then(() => {
    if (disposed) return;
    document.getElementById(`composer-prompt-history-option-${selectedIndex}`)?.scrollIntoView?.({ block: 'nearest' });
  });
}

function moveSelection(delta: number) {
  if (filteredPrompts.length === 0) return;
  selectedIndex = (selectedIndex + delta + filteredPrompts.length) % filteredPrompts.length;
  scrollSelectedPromptIntoView();
}

function handleSearchKeydown(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    close();
    return;
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    moveSelection(event.key === 'ArrowDown' ? 1 : -1);
    return;
  }
  if (event.key === 'Enter' && filteredPrompts[selectedIndex]) {
    event.preventDefault();
    select(filteredPrompts[selectedIndex].text);
  }
}

function handleQueryInput(event: Event) {
  query = (event.currentTarget as HTMLInputElement).value;
  selectedIndex = 0;
}

function handleOpenChange(nextOpen: boolean) {
  if (nextOpen) {
    closingFromOutside = false;
    requestOpen();
    return;
  }
  const preserveOutsideFocus = closingFromOutside;
  closingFromOutside = false;
  if (preserveOutsideFocus) dismissOutside();
  else close();
}

function handleInteractOutside() {
  closingFromOutside = true;
}

function focusSearch(event: Event) {
  event.preventDefault();
  if (disposed) return;
  if (!open || closingFromOutside) return;
  searchElement?.focus();
}

function preventPopoverAutoFocus(event: Event) {
  event.preventDefault();
}

onDestroy(() => {
  disposed = true;
});
</script>

<PopoverShell
  {open}
  onOpenChange={handleOpenChange}
  side="top"
  align="end"
  sideOffset={7}
  trapFocus={false}
  contentClass="composer-history-popover"
  triggerClass="composer-history-button"
  triggerLabel={open ? 'Close Composer history' : 'Open Composer history'}
  triggerTitle="Composer history (Ctrl+Alt+H)"
  triggerAriaKeyShortcuts="Control+Alt+H"
  onInteractOutside={handleInteractOutside}
  onOpenAutoFocus={focusSearch}
  onCloseAutoFocus={preventPopoverAutoFocus}
>
  {#snippet trigger()}
    <History size={18} strokeWidth={1.8} aria-hidden="true" />
  {/snippet}
  {#snippet children()}
    <section class="prompt-history" aria-label="Composer history" data-vampire-overlay>
      <label class="history-search-label" for="composer-history-search">Search sent prompts</label>
      <input
        id="composer-history-search"
        bind:this={searchElement}
        class="history-search"
        type="search"
        value={query}
        oninput={handleQueryInput}
        onkeydown={handleSearchKeydown}
        placeholder="Search Composer history…"
        autocomplete="off"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded="true"
        aria-controls="composer-prompt-history-list"
        aria-activedescendant={filteredPrompts[selectedIndex]
          ? `composer-prompt-history-option-${selectedIndex}`
          : undefined}
      >
      {#if loading}
        <p class="prompt-history-message" role="status">Loading history…</p>
      {:else if error}
        <p class="prompt-history-message error" role="alert">{error}</p>
      {:else if prompts.length === 0}
        <p class="prompt-history-message">Prompts sent from this Composer will appear here.</p>
      {:else if filteredPrompts.length === 0}
        <p class="prompt-history-message">No prompts match “{query}”.</p>
      {:else}
        <div id="composer-prompt-history-list" class="prompt-history-list" role="listbox" aria-label="Matching prompts">
          {#each filteredPrompts as prompt, index (prompt.id)}
            <button
              id={`composer-prompt-history-option-${index}`}
              type="button"
              role="option"
              class="prompt-history-item"
              class:selected={index === selectedIndex}
              aria-selected={index === selectedIndex}
              onmouseenter={() => (selectedIndex = index)}
              onclick={() => select(prompt.text)}
            >
              <span>{prompt.text}</span>
              <time datetime={new Date(prompt.submittedAt).toISOString()}
                >{formatPromptTimestamp(prompt.submittedAt)}</time
              >
            </button>
          {/each}
        </div>
      {/if}
      <p class="history-help">Type to search · ↑↓ to choose · Enter to insert · Esc to close</p>
    </section>
  {/snippet}
</PopoverShell>

<style>
.prompt-history {
  display: grid;
  gap: 0.65rem;
  min-width: 0;
}
:global(.composer-history-button) {
  display: grid;
  place-items: center;
  width: var(--composer-control-size);
  height: var(--composer-control-size);
  padding: 0;
  border: 0;
  border-radius: 0.58rem;
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
  touch-action: manipulation;
}
@media (hover: hover) {
  :global(.composer-history-button:hover) {
    background: var(--color-surface-hover);
    color: var(--color-text);
  }
}
:global(.composer-history-popover) {
  box-sizing: border-box;
  z-index: 70;
  width: min(34rem, calc(100vw - 1rem));
  max-height: min(34rem, calc(100dvh - 1rem));
  padding: 0.75rem;
  overflow: hidden;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-md);
  outline: none;
  background: var(--color-surface);
  box-shadow: var(--shadow-popover);
  color: var(--color-text);
}
.history-search-label {
  color: var(--color-text-secondary);
  font-size: var(--text-caption);
  font-weight: var(--weight-medium);
}
.history-search {
  width: 100%;
  min-height: 2.5rem;
  padding: 0.5rem 0.65rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-control);
  outline: none;
  background: var(--color-control-background);
  color: var(--color-text);
  font: inherit;
}
.history-search:focus {
  border-color: var(--color-accent);
  box-shadow: var(--shadow-accent-focus);
}
.history-search::placeholder {
  color: var(--color-field-placeholder);
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
.prompt-history-item.selected {
  background: var(--color-surface-active);
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
.prompt-history-message {
  margin: 0;
  padding: 0.7rem 0.75rem;
  color: var(--color-text-secondary);
  font-size: var(--text-caption);
  line-height: var(--leading-ui);
}
.prompt-history-message.error {
  color: var(--color-danger);
}
.history-help {
  margin: 0;
  color: var(--color-text-disabled);
  font-size: var(--text-micro);
}
</style>
