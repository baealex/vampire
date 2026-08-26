<script lang="ts">
import ChevronDown from '@lucide/svelte/icons/chevron-down';
import ChevronUp from '@lucide/svelte/icons/chevron-up';
import type { Snippet } from 'svelte';
import Button from './Button.svelte';
import DropdownMenuShell from './DropdownMenuShell.svelte';

let {
  class: className,
  variant = 'primary',
  disabled = false,
  menuOpen = $bindable(false),
  onMenuOpenChange = () => undefined,
  primaryLabel,
  primaryTitle,
  menuLabel = 'More actions',
  menuTitle,
  menuSide = 'bottom',
  menuAlign = 'end',
  showMenu = true,
  onclick,
  primary,
  menu,
}: {
  class?: string;
  variant?: 'primary' | 'navigation';
  disabled?: boolean;
  menuOpen?: boolean;
  onMenuOpenChange?: (open: boolean) => void;
  primaryLabel?: string;
  primaryTitle?: string;
  menuLabel?: string;
  menuTitle?: string;
  menuSide?: 'top' | 'bottom';
  menuAlign?: 'start' | 'center' | 'end';
  showMenu?: boolean;
  onclick?: (event: MouseEvent) => void;
  primary: Snippet;
  menu?: Snippet;
} = $props();

const rootClass = $derived(
  ['vampire-split-button', `vampire-split-button--${variant}`, className ?? ''].filter(Boolean).join(' ')
);
const primaryVariant = $derived(variant === 'primary' ? 'primary' : 'ghost');

function handleMenuOpenChange(open: boolean) {
  menuOpen = open;
  onMenuOpenChange(open);
}
</script>

<div class={rootClass}>
  <Button
    class="vampire-split-button__primary"
    variant={primaryVariant}
    size="lg"
    {disabled}
    ariaLabel={primaryLabel}
    title={primaryTitle}
    {onclick}
  >
    {@render primary()}
  </Button>

  {#if showMenu && menu}
    <DropdownMenuShell
      open={menuOpen}
      onOpenChange={handleMenuOpenChange}
      side={menuSide}
      align={menuAlign}
      triggerClass="vampire-split-button__menu-trigger"
      triggerLabel={menuLabel}
      triggerTitle={menuTitle}
    >
      {#snippet trigger()}
        <span class="vampire-split-button__chevron" data-direction={menuSide} aria-hidden="true">
          {#if menuSide === 'top'}
            <ChevronUp size={16} strokeWidth={1.8} />
          {:else}
            <ChevronDown size={16} strokeWidth={1.8} />
          {/if}
        </span>
      {/snippet}

      {#snippet children()}
        {@render menu()}
      {/snippet}
    </DropdownMenuShell>
  {/if}
</div>

<style>
.vampire-split-button {
  --split-button-height: var(--control-height-lg);
  display: inline-flex;
  min-width: 0;
  overflow: hidden;
  border-radius: var(--radius-sm);
}
.vampire-split-button--primary {
  background: var(--color-accent);
}
.vampire-split-button--navigation {
  --split-button-height: 3.25rem;
  width: 100%;
  border-radius: 0;
  background: transparent;
}
:global(.vampire-split-button__primary.vampire-button) {
  flex: 1 1 auto;
  min-width: 0;
  min-height: var(--split-button-height);
  border-radius: 0;
}
.vampire-split-button--navigation :global(.vampire-split-button__primary.vampire-button) {
  justify-content: flex-start;
  width: 100%;
  padding: 0.4rem 1rem;
  background: transparent;
  color: inherit;
  text-align: left;
}
@media (hover: hover) {
  .vampire-split-button--navigation :global(.vampire-split-button__primary.vampire-button:hover:not(:disabled)) {
    background: var(--color-surface-raised);
  }
}
:global(.vampire-split-button__menu-trigger.vampire-menu-trigger) {
  display: grid;
  flex: 0 0 var(--split-button-height);
  place-items: center;
  width: var(--split-button-height);
  min-width: var(--split-button-height);
  min-height: var(--split-button-height);
  height: auto;
  padding: 0;
  border: 0;
  border-left: 1px solid color-mix(in srgb, var(--color-accent-ink) 24%, transparent);
  border-radius: 0;
  background: transparent;
  color: var(--color-accent-ink);
  cursor: pointer;
}
.vampire-split-button--navigation :global(.vampire-split-button__menu-trigger.vampire-menu-trigger) {
  border-left-color: var(--color-border);
  color: var(--color-text-tertiary);
}
:global(.vampire-split-button__menu-trigger.vampire-menu-trigger:focus-visible),
:global(.vampire-split-button__menu-trigger.vampire-menu-trigger[data-state="open"]) {
  background: color-mix(in srgb, var(--color-accent-ink) 12%, transparent);
  outline: none;
}
.vampire-split-button--navigation :global(.vampire-split-button__menu-trigger.vampire-menu-trigger:focus-visible),
.vampire-split-button--navigation :global(.vampire-split-button__menu-trigger.vampire-menu-trigger[data-state="open"]) {
  background: var(--color-surface-raised);
  color: var(--color-text);
}
@media (hover: hover) {
  :global(.vampire-split-button__menu-trigger.vampire-menu-trigger:hover) {
    background: color-mix(in srgb, var(--color-accent-ink) 12%, transparent);
  }
  .vampire-split-button--navigation :global(.vampire-split-button__menu-trigger.vampire-menu-trigger:hover) {
    background: var(--color-surface-raised);
    color: var(--color-text);
  }
}
.vampire-split-button__chevron {
  display: grid;
  place-items: center;
}
</style>
