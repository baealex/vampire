<script lang="ts">
import type { Snippet } from 'svelte';

let {
  label,
  title = label,
  text,
  type = 'button',
  disabled = false,
  compact = false,
  active = false,
  expanded,
  onclick,
  children,
}: {
  label: string;
  title?: string;
  text?: string;
  type?: 'button' | 'submit' | 'reset';
  disabled?: boolean;
  compact?: boolean;
  active?: boolean;
  expanded?: boolean;
  onclick?: (event: MouseEvent) => void;
  children: Snippet;
} = $props();
</script>

<button
  class:compact
  class:has-text={Boolean(text)}
  class:active
  {type}
  {disabled}
  {onclick}
  aria-label={label}
  {title}
  aria-expanded={expanded}
>
  {@render children()}
  {#if text}
    <span class="toolbar-button__text">{text}</span>
  {/if}
</button>

<style>
button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--control-size-icon);
  height: var(--control-size-icon);
  min-width: var(--control-size-icon);
  gap: 0.38rem;
  padding: 0;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-secondary);
  font: inherit;
  cursor: pointer;
}

button:disabled {
  cursor: wait;
  opacity: 0.55;
}
button.compact {
  width: 2.15rem;
  height: 2.15rem;
  min-width: 2.15rem;
  border-radius: 0;
}
button.compact.has-text {
  width: 4.7rem;
  min-width: 4.7rem;
  padding-inline: 0.7rem;
  color: var(--color-text-tertiary);
  font-size: var(--text-caption);
  font-weight: var(--weight-medium);
}
button:focus-visible,
button.active {
  background: var(--color-surface-hover);
  color: var(--color-text);
  outline: none;
}
@media (hover: hover) {
  button:hover {
    background: var(--color-surface-raised);
    color: var(--color-text);
  }
  button.compact:hover,
  button.compact.has-text:hover {
    background: var(--color-surface-hover);
  }
}
@media (max-width: 32rem) {
  button.compact.has-text {
    width: 2.15rem;
    min-width: 2.15rem;
    padding: 0;
  }
  button.compact.has-text .toolbar-button__text {
    display: none;
  }
}
</style>
