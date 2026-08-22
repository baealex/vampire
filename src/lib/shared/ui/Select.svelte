<script lang="ts">
import type { Snippet } from 'svelte';

let {
  value = $bindable(''),
  class: className,
  id,
  name,
  disabled = false,
  required = false,
  ariaLabel,
  size = 'md',
  children,
  onchange,
}: {
  value?: string;
  class?: string;
  id?: string;
  name?: string;
  disabled?: boolean;
  required?: boolean;
  ariaLabel?: string;
  size?: 'sm' | 'md' | 'lg';
  children?: Snippet;
  onchange?: (event: Event) => void;
} = $props();

const selectClass = $derived(`select select--${size}${className ? ` ${className}` : ''}`);
</script>

<select class={selectClass} bind:value {id} {name} {disabled} {required} aria-label={ariaLabel} {onchange}>
  {@render children?.()}
</select>

<style>
.select {
  width: 100%;
  min-width: 0;
  min-height: var(--control-height-md);
  padding: 0 var(--control-padding-inline-sm);
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-sm);
  outline: none;
  background: var(--color-field-background);
  color: var(--color-text);
  font: inherit;
  font-size: var(--text-label);
}

.select--sm {
  min-height: var(--control-height-sm);
}

.select--lg {
  min-height: var(--control-height-lg);
}

.select:focus {
  border-color: var(--color-accent);
  box-shadow: var(--shadow-accent-focus);
}

.select:focus-visible {
  outline: none;
}

.select:disabled {
  cursor: wait;
  opacity: 0.62;
}

@media (max-width: 32rem) {
  .select {
    font-size: 1rem;
  }
}
</style>
