<script lang="ts">
import type { Snippet } from 'svelte';

let {
  class: className,
  variant = 'secondary',
  size = 'md',
  type = 'button',
  disabled = false,
  block = false,
  id,
  ariaLabel,
  ariaPressed,
  ariaExpanded,
  ariaControls,
  title,
  form,
  onclick,
  children,
}: {
  class?: string;
  variant?: 'primary' | 'secondary' | 'danger' | 'danger-outline' | 'ghost' | 'icon';
  size?: 'sm' | 'md' | 'lg';
  type?: 'button' | 'submit' | 'reset';
  disabled?: boolean;
  block?: boolean;
  id?: string;
  ariaLabel?: string;
  ariaPressed?: boolean | 'true' | 'false';
  ariaExpanded?: boolean;
  ariaControls?: string;
  title?: string;
  form?: string;
  onclick?: (event: MouseEvent) => void;
  children: Snippet;
} = $props();

const buttonClass = $derived(
  [
    'vampire-button',
    `vampire-button--${variant}`,
    variant === 'icon' ? '' : `vampire-button--${size}`,
    block ? 'vampire-button--block' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ')
);
</script>

<button
  class={buttonClass}
  {id}
  {type}
  {disabled}
  {title}
  {form}
  aria-label={ariaLabel}
  aria-pressed={ariaPressed}
  aria-expanded={ariaExpanded}
  aria-controls={ariaControls}
  {onclick}
>
  {@render children()}
</button>

<style>
button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  min-height: var(--control-height-md);
  padding: 0 var(--control-padding-inline-md);
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: var(--color-surface-raised);
  color: var(--color-text);
  font: inherit;
  font-size: var(--text-label);
  font-weight: var(--weight-medium);
  line-height: var(--leading-ui);
  text-decoration: none;
  cursor: pointer;
}

button.vampire-button--primary {
  background: var(--color-accent);
  color: var(--color-accent-ink);
}

button.vampire-button--danger {
  background: var(--color-danger-action);
  color: var(--color-danger-action-ink);
}

button.vampire-button--danger-outline {
  border-color: var(--color-danger-border);
  background: transparent;
  color: var(--color-danger-text);
}

button.vampire-button--ghost {
  border-color: transparent;
  background: transparent;
  color: var(--color-text-secondary);
}

button.vampire-button--icon {
  width: var(--control-size-icon);
  min-width: var(--control-size-icon);
  padding: 0;
  background: transparent;
  color: var(--color-text-secondary);
}

button.vampire-button--sm {
  min-height: var(--control-height-sm);
  padding-inline: var(--control-padding-inline-sm);
}

button.vampire-button--lg {
  min-height: var(--control-height-lg);
  padding-inline: var(--control-padding-inline-lg);
}

button.vampire-button--block {
  width: 100%;
}

button:focus-visible {
  outline: none;
  box-shadow: var(--shadow-accent-focus);
}

@media (hover: hover) {
  button.vampire-button--primary:hover:not(:disabled) {
    background: var(--color-accent-hover);
  }

  button.vampire-button--danger:hover:not(:disabled) {
    background: var(--color-danger-action-hover);
  }

  button.vampire-button--danger-outline:hover:not(:disabled) {
    background: var(--color-danger-surface-hover);
  }

  button.vampire-button--ghost:hover:not(:disabled),
  button.vampire-button--secondary:hover:not(:disabled),
  button.vampire-button--icon:hover:not(:disabled) {
    background: var(--color-surface-hover);
  }
}

button:disabled {
  cursor: wait;
  opacity: 0.62;
}
</style>
