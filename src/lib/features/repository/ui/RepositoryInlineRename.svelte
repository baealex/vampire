<script lang="ts">
import { tick } from 'svelte';
import FileText from '@lucide/svelte/icons/file-text';
import Folder from '@lucide/svelte/icons/folder';
import Button from '~/lib/shared/ui/Button.svelte';
import Input from '~/lib/shared/ui/Input.svelte';
import type { WorkspaceEntryKind } from '~/lib/shared/contracts/repository.ts';

let {
  kind,
  depth,
  value = $bindable(),
  error = '',
  renaming = false,
  onSubmit,
  onCancel,
}: {
  kind: WorkspaceEntryKind;
  depth: number;
  value: string;
  error?: string;
  renaming?: boolean;
  onSubmit: () => void;
  onCancel: () => void;
} = $props();

let input = $state<HTMLInputElement>();

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter') {
    event.preventDefault();
    onSubmit();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    onCancel();
  }
}

$effect(() => {
  void tick().then(() => {
    input?.focus();
    const extension = kind === 'file' ? value.lastIndexOf('.') : -1;
    input?.setSelectionRange(0, extension > 0 ? extension : value.length);
  });
});
</script>

<div class="tree-rename-row" data-inline-repository-entry="true">
  <span class="tree-indent" aria-hidden="true">
    {#each Array(depth) as _}
      <span></span>
    {/each}
  </span>
  <span class="tree-chevron" aria-hidden="true"></span>
  <span class="tree-icon" aria-hidden="true">
    {#if kind === 'directory'}
      <Folder size={15} strokeWidth={1.7} />
    {:else}
      <FileText size={15} strokeWidth={1.7} />
    {/if}
  </span>
  <Input
    bind:element={input}
    bind:value
    class={`tree-rename-input${error ? ' error' : ''}`}
    size="sm"
    mono
    ariaLabel={`Rename ${kind}`}
    autocomplete="off"
    spellcheck="false"
    disabled={renaming}
    onkeydown={handleKeydown}
  />
  <Button
    variant="icon"
    class="tree-rename-action"
    onclick={onSubmit}
    disabled={renaming}
    ariaLabel="Rename"
    title="Rename"
    >↵</Button
  >
  <Button
    variant="icon"
    class="tree-rename-action"
    onclick={onCancel}
    disabled={renaming}
    ariaLabel="Cancel"
    title="Cancel"
    >×</Button
  >
</div>
{#if error}
  <p class="tree-rename-error" role="alert">{error}</p>
{/if}

<style>
.tree-rename-row {
  display: flex;
  align-items: center;
  min-width: 0;
  min-height: 2rem;
  padding: 0 0.35rem 0 0.65rem;
  background: var(--color-surface-active);
}
:global(.tree-rename-input) {
  flex: 1 1 auto;
  min-width: 0;
  height: 1.7rem;
  min-height: 1.7rem;
  padding: 0 0.4rem;
  border: 1px solid var(--color-accent);
  border-radius: 0.35rem;
  background: var(--color-field-background);
  color: var(--color-text);
  font-family: var(--font-mono);
  font-size: var(--text-caption);
}
:global(.tree-rename-input.error) {
  border-color: var(--color-danger-border-strong);
}
:global(.tree-rename-action) {
  flex: 0 0 1.8rem;
  width: 1.8rem;
  min-width: 1.8rem;
  height: 1.8rem;
  padding: 0;
}
.tree-rename-error {
  margin: 0;
  padding: 0.2rem 0.7rem 0.35rem 2.95rem;
  color: var(--color-danger-text);
  font-size: var(--text-micro);
}
.tree-indent {
  display: inline-flex;
  flex: 0 0 auto;
}
.tree-indent > span {
  width: 0.72rem;
}
.tree-chevron {
  flex: 0 0 1rem;
  width: 1rem;
}
.tree-icon {
  display: grid;
  flex: 0 0 1.35rem;
  place-items: center;
  width: 1.35rem;
  color: var(--color-folder);
}
</style>
