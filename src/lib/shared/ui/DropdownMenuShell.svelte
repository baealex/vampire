<script lang="ts">
import { DropdownMenu } from 'bits-ui';
import type { Snippet } from 'svelte';

let {
  open = $bindable(false),
  onOpenChange = () => undefined,
  triggerLabel,
  triggerTitle,
  triggerClass,
  triggerVariant = 'default',
  side = 'bottom',
  align = 'start',
  trigger,
  children,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  triggerLabel: string;
  triggerTitle?: string;
  triggerClass?: string;
  triggerVariant?: 'default' | 'primary';
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  trigger?: Snippet;
  children?: Snippet;
} = $props();

const triggerClassName = $derived(
  ['vampire-menu-trigger', triggerVariant === 'primary' ? 'vampire-menu-trigger--primary' : '', triggerClass ?? '']
    .filter(Boolean)
    .join(' ')
);

function handleOpenChange(nextOpen: boolean) {
  open = nextOpen;
  onOpenChange(nextOpen);
}
</script>

<DropdownMenu.Root bind:open onOpenChange={handleOpenChange}>
  <DropdownMenu.Trigger class={triggerClassName} aria-label={triggerLabel} title={triggerTitle}>
    {@render trigger?.()}
  </DropdownMenu.Trigger>
  <DropdownMenu.Portal>
    <DropdownMenu.Content data-vampire-overlay class="vampire-menu-content" sideOffset={6} {side} {align}>
      {@render children?.()}
    </DropdownMenu.Content>
  </DropdownMenu.Portal>
</DropdownMenu.Root>

<style>
:global(.vampire-menu-trigger) {
  display: grid;
  place-items: center;
  width: 2rem;
  height: 2rem;
  padding: 0;
  border: 0;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--color-text-tertiary);
  cursor: pointer;
}

:global(.vampire-menu-trigger:focus-visible),
:global(.vampire-menu-trigger[data-state="open"]) {
  background: var(--color-control-hover);
  color: var(--color-text);
  outline: none;
}

@media (hover: hover) {
  :global(.vampire-menu-trigger:hover) {
    background: var(--color-control-hover);
    color: var(--color-text);
  }
}

:global(.vampire-menu-content) {
  z-index: 55;
  display: grid;
  min-width: 13rem;
  max-width: min(20rem, calc(100vw - 1rem));
  gap: 0.2rem;
  padding: 0.35rem;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-md);
  outline: none;
  background: var(--color-surface-overlay);
  box-shadow: var(--shadow-popover);
  color: var(--color-text);
}

:global(.vampire-menu-content[data-state="closed"]) {
  display: none;
}

@media (pointer: coarse) {
  :global(.vampire-menu-trigger) {
    min-width: 2.75rem;
    height: 2.75rem;
  }
}

:global(.vampire-menu-trigger--primary) {
  display: inline-flex;
  width: auto;
  min-width: 0;
  min-height: 2.35rem;
  height: auto;
  padding: 0 0.72rem;
  border-radius: var(--radius-control);
  background: var(--color-accent);
  color: var(--color-accent-ink);
  font: inherit;
  font-size: var(--text-label);
  font-weight: var(--weight-medium);
}

:global(.vampire-menu-trigger--primary[data-state="open"]) {
  background: var(--color-accent-hover);
  color: var(--color-accent-ink);
}

@media (hover: hover) {
  :global(.vampire-menu-trigger--primary:hover) {
    background: var(--color-accent-hover);
    color: var(--color-accent-ink);
  }
}
</style>
