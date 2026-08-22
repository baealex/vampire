<script lang="ts">
import { DropdownMenu } from 'bits-ui';
import type { Snippet } from 'svelte';

let {
  class: className,
  disabled = false,
  tone = 'default',
  align = 'start',
  ariaLabel,
  onSelect,
  children,
}: {
  class?: string;
  disabled?: boolean;
  tone?: 'default' | 'danger';
  align?: 'start' | 'center';
  ariaLabel?: string;
  onSelect?: (event: Event) => void;
  children?: Snippet;
} = $props();

const itemClass = $derived(
  [
    'vampire-menu-item',
    tone === 'danger' ? 'vampire-menu-item--danger' : '',
    align === 'center' ? 'vampire-menu-item--centered' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ')
);
</script>

<DropdownMenu.Item class={itemClass} {disabled} aria-label={ariaLabel} {onSelect}>
  {@render children?.()}
</DropdownMenu.Item>

<style>
:global(.vampire-menu-item) {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  width: 100%;
  min-height: var(--control-height-sm);
  padding: 0 0.6rem;
  border: 0;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--color-text-secondary);
  font: inherit;
  font-size: var(--text-label);
  text-align: left;
  cursor: pointer;
}

:global(.vampire-menu-item[data-highlighted]) {
  background: var(--color-surface-hover);
  color: var(--color-text);
  outline: none;
}

@media (hover: hover) {
  :global(.vampire-menu-item:hover) {
    background: var(--color-surface-hover);
    color: var(--color-text);
    outline: none;
  }
}

:global(.vampire-menu-item--danger) {
  color: var(--color-danger-text);
}

:global(.vampire-menu-item--centered) {
  justify-content: center;
  padding-inline: 0.35rem;
}

:global(.vampire-menu-item--danger[data-highlighted]) {
  background: var(--color-danger-surface-hover);
  color: var(--color-danger-text-strong);
}

@media (hover: hover) {
  :global(.vampire-menu-item--danger:hover) {
    background: var(--color-danger-surface-hover);
    color: var(--color-danger-text-strong);
  }
}

:global(.vampire-menu-item[aria-disabled="true"]) {
  cursor: not-allowed;
  opacity: 0.5;
}

@media (pointer: coarse) {
  :global(.vampire-menu-item) {
    min-height: 2.75rem;
  }
}
</style>
