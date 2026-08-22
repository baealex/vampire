<script lang="ts">
import ArrowLeft from '@lucide/svelte/icons/arrow-left';
import type { Snippet } from 'svelte';

let {
  eyebrow,
  onBack,
  backDisabled = false,
  backLabel = 'Back',
  titleContent,
  closeContent,
  children,
  footer,
  footerVisible = true,
}: {
  eyebrow?: string;
  onBack?: () => void;
  backDisabled?: boolean;
  backLabel?: string;
  titleContent: Snippet;
  closeContent: Snippet;
  children?: Snippet;
  footer?: Snippet;
  footerVisible?: boolean;
} = $props();
</script>

<header class="vampire-dialog-header">
  <div class="vampire-dialog-heading">
    {#if onBack}
      <button type="button" class="vampire-dialog-back" onclick={onBack} disabled={backDisabled} aria-label={backLabel}>
        <ArrowLeft size={18} strokeWidth={1.8} aria-hidden="true" />
      </button>
    {/if}
    <div class="vampire-dialog-heading-copy">
      {#if eyebrow}
        <p class="vampire-dialog-eyebrow">{eyebrow}</p>
      {/if}
      {@render titleContent()}
    </div>
  </div>
  {@render closeContent()}
</header>
<div class="vampire-dialog-body">
  {@render children?.()}
</div>
{#if footer && footerVisible}
  <footer class="vampire-dialog-footer">
    {@render footer()}
  </footer>
{/if}

<style>
:global(.vampire-dialog-overlay) {
  position: fixed;
  z-index: 50;
  inset: 0;
  background: var(--color-backdrop);
}

:global(.vampire-dialog-content) {
  position: fixed;
  z-index: 51;
  top: 50%;
  left: 50%;
  display: flex;
  flex-direction: column;
  width: min(calc(100% - 2rem), 28rem);
  max-height: calc(100dvh - 2rem);
  overflow: hidden;
  transform: translate(-50%, -50%);
  gap: 0;
  padding: 0;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-lg);
  background: var(--color-surface-overlay);
  box-shadow: var(--shadow-dialog);
}

:global(.vampire-dialog-content--inspect) {
  width: min(calc(100% - 2rem), 46rem);
}

:global(.vampire-dialog-content--form) {
  width: min(calc(100% - 2rem), 38.5rem);
}

:global(.vampire-alert-dialog-overlay) {
  z-index: 60;
}

:global(.vampire-alert-dialog-content) {
  z-index: 61;
}

.vampire-dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 1.1rem max(1.1rem, env(safe-area-inset-right)) 0.85rem max(1.1rem, env(safe-area-inset-left));
  border-bottom: 1px solid var(--color-border-subtle);
}

.vampire-dialog-heading {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 0.55rem;
}

.vampire-dialog-heading-copy {
  min-width: 0;
}

.vampire-dialog-eyebrow {
  margin: 0;
  color: var(--color-text-tertiary);
  font-size: var(--text-caption);
  font-weight: var(--weight-medium);
  line-height: var(--leading-ui);
}

:global(.vampire-dialog-title) {
  display: block;
  overflow: hidden;
  margin: 0;
  font-size: var(--text-heading);
  font-weight: var(--weight-strong);
  line-height: var(--leading-tight);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vampire-dialog-eyebrow + :global(.vampire-dialog-title) {
  margin-top: 0.2rem;
}

.vampire-dialog-back,
:global(.vampire-dialog-close) {
  display: grid;
  flex: 0 0 auto;
  place-items: center;
  width: 2.35rem;
  height: 2.35rem;
  padding: 0;
  border: 0;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
}

.vampire-dialog-back {
  margin-left: -0.45rem;
}

@media (hover: hover) {
  .vampire-dialog-back:hover:not(:disabled),
  :global(.vampire-dialog-close:hover:not(:disabled)) {
    background: var(--color-surface-hover);
    color: var(--color-text);
  }
}

:global(.vampire-dialog-close:disabled),
.vampire-dialog-back:disabled {
  cursor: wait;
  opacity: 0.62;
}

.vampire-dialog-body {
  --vampire-dialog-body-inline-padding: max(1.1rem, env(safe-area-inset-right));
  --vampire-dialog-body-inline-padding-start: max(1.1rem, env(safe-area-inset-left));
  --vampire-dialog-body-block-padding: 1rem;
  --vampire-dialog-body-bottom-padding: max(1.1rem, env(safe-area-inset-bottom));
  display: grid;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  align-content: start;
  gap: 1rem;
  padding: var(--vampire-dialog-body-block-padding) var(--vampire-dialog-body-inline-padding)
    var(--vampire-dialog-body-bottom-padding) var(--vampire-dialog-body-inline-padding-start);
}

.vampire-dialog-footer {
  flex: 0 0 auto;
  min-width: 0;
  padding: 0.85rem max(1.1rem, env(safe-area-inset-right)) max(1.1rem, env(safe-area-inset-bottom))
    max(1.1rem, env(safe-area-inset-left));
  border-top: 1px solid var(--color-border-subtle);
}

:global(.vampire-dialog-button) {
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
  cursor: pointer;
}

:global(.vampire-dialog-button--primary) {
  background: var(--color-accent);
  color: var(--color-accent-ink);
}

:global(.vampire-dialog-button--danger) {
  background: var(--color-danger-action);
  color: var(--color-danger-action-ink);
}

:global(.vampire-dialog-button--danger-outline) {
  border-color: var(--color-danger-border);
  background: transparent;
  color: var(--color-danger-text);
}

:global(.vampire-dialog-button:focus-visible) {
  outline: none;
  box-shadow: var(--shadow-accent-focus);
}

@media (hover: hover) {
  :global(.vampire-dialog-button--primary:hover:not(:disabled)) {
    background: var(--color-accent-hover);
  }

  :global(.vampire-dialog-button:hover:not(:disabled)) {
    background: var(--color-surface-hover);
  }

  :global(.vampire-dialog-button--danger:hover:not(:disabled)) {
    background: var(--color-danger-action-hover);
  }

  :global(.vampire-dialog-button--danger-outline:hover:not(:disabled)) {
    background: var(--color-danger-surface-hover);
  }
}

:global(.vampire-dialog-button:disabled) {
  cursor: wait;
  opacity: 0.62;
}

@media (max-width: 39.999rem), (max-width: 63.999rem) and (hover: none) and (pointer: coarse) {
  :global(.vampire-dialog-content) {
    top: auto;
    bottom: 0;
    width: 100%;
    max-height: calc(100dvh - 1rem);
    transform: translateX(-50%);
    padding: 0;
    border-right: 0;
    border-bottom: 0;
    border-left: 0;
    border-radius: var(--radius-lg) var(--radius-lg) 0 0;
  }

  .vampire-dialog-header {
    align-items: center;
    padding: 0.55rem max(0.85rem, env(safe-area-inset-right)) 0.55rem max(0.85rem, env(safe-area-inset-left));
    border-bottom: 1px solid var(--color-border-subtle);
  }

  .vampire-dialog-body {
    --vampire-dialog-body-inline-padding: max(0.85rem, env(safe-area-inset-right));
    --vampire-dialog-body-inline-padding-start: max(0.85rem, env(safe-area-inset-left));
    --vampire-dialog-body-block-padding: 0.85rem;
    --vampire-dialog-body-bottom-padding: max(0.85rem, env(safe-area-inset-bottom));
    min-height: 0;
    padding: var(--vampire-dialog-body-block-padding) var(--vampire-dialog-body-inline-padding)
      var(--vampire-dialog-body-bottom-padding) var(--vampire-dialog-body-inline-padding-start);
  }

  .vampire-dialog-footer {
    padding: 0.85rem max(0.85rem, env(safe-area-inset-right)) max(0.85rem, env(safe-area-inset-bottom))
      max(0.85rem, env(safe-area-inset-left));
  }
}
</style>
