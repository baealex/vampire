<script lang="ts">
import Minus from '@lucide/svelte/icons/minus';
import Plus from '@lucide/svelte/icons/plus';
import Type from '@lucide/svelte/icons/type';
import DropdownMenuHeading from '~/lib/shared/ui/DropdownMenuHeading.svelte';
import DropdownMenuItem from '~/lib/shared/ui/DropdownMenuItem.svelte';
import DropdownMenuSeparator from '~/lib/shared/ui/DropdownMenuSeparator.svelte';
import DropdownMenuShell from '~/lib/shared/ui/DropdownMenuShell.svelte';

let {
  fontSize,
  minimumFontSize,
  maximumFontSize,
  decreaseFontSize,
  increaseFontSize,
}: {
  fontSize: number;
  minimumFontSize: number;
  maximumFontSize: number;
  decreaseFontSize: () => void;
  increaseFontSize: () => void;
} = $props();

function keepOpen(event: Event, change: () => void) {
  event.preventDefault();
  change();
}
</script>

<div class="terminal-display-menu">
  <DropdownMenuShell align="end" triggerClass="terminal-display-trigger" triggerLabel="Terminal display settings">
    {#snippet trigger()}
      <Type size={17} strokeWidth={1.8} aria-hidden="true" />
    {/snippet}

    {#snippet children()}
      <DropdownMenuHeading title="Terminal display" subtitle={`Text size: ${fontSize}px`} />
      <DropdownMenuSeparator />
      <DropdownMenuItem disabled={fontSize <= minimumFontSize} onSelect={(event) => keepOpen(event, decreaseFontSize)}>
        <Minus size={15} strokeWidth={2} aria-hidden="true" />
        Decrease text size
      </DropdownMenuItem>
      <DropdownMenuItem disabled={fontSize >= maximumFontSize} onSelect={(event) => keepOpen(event, increaseFontSize)}>
        <Plus size={15} strokeWidth={2} aria-hidden="true" />
        Increase text size
      </DropdownMenuItem>
    {/snippet}
  </DropdownMenuShell>
</div>

<style>
:global(.terminal-display-trigger) {
  width: 2.35rem;
  height: 2.35rem;
  border: 1px solid transparent;
  border-radius: var(--radius-control);
}
:global(.terminal-display-trigger:focus-visible),
:global(.terminal-display-trigger[data-state="open"]) {
  border-color: var(--color-border-strong);
  background: transparent;
  color: var(--color-text);
  outline: none;
}
@media (hover: hover) {
  :global(.terminal-display-trigger:hover) {
    border-color: var(--color-border-strong);
    background: transparent;
    color: var(--color-text);
    outline: none;
  }
}
</style>
