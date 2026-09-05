<script lang="ts">
import Eye from '@lucide/svelte/icons/eye';
import WandSparkles from '@lucide/svelte/icons/wand-sparkles';
import X from '@lucide/svelte/icons/x';
import { onDestroy } from 'svelte';
import PopoverShell from '~/lib/shared/ui/PopoverShell.svelte';

let {
  bypassed,
  hasDraft,
  previewOpen,
  previewText,
  previewWarning,
  toggleBypass,
  openPreview,
  closePreview,
  dismissPreviewOutside,
}: {
  bypassed: boolean;
  hasDraft: boolean;
  previewOpen: boolean;
  previewText: string;
  previewWarning?: string;
  toggleBypass: () => void;
  openPreview: () => void;
  closePreview: () => void;
  dismissPreviewOutside: () => void;
} = $props();

let closingFromOutside = false;
let previewCloseElement = $state<HTMLButtonElement>();
let disposed = false;

function keepComposerFocus(event: PointerEvent) {
  event.preventDefault();
}

function handlePreviewOpenChange(nextOpen: boolean) {
  if (nextOpen) {
    closingFromOutside = false;
    openPreview();
    return;
  }
  const preserveOutsideFocus = closingFromOutside;
  closingFromOutside = false;
  if (preserveOutsideFocus) dismissPreviewOutside();
  else closePreview();
}

function handleInteractOutside() {
  closingFromOutside = true;
}

function focusPreview(event: Event) {
  event.preventDefault();
  if (disposed) return;
  if (!previewOpen || closingFromOutside) return;
  previewCloseElement?.focus({ preventScroll: true });
}

function preventPopoverAutoFocus(event: Event) {
  event.preventDefault();
}

onDestroy(() => {
  disposed = true;
});
</script>

<div class="composer-template-tools" role="group" aria-label="Composer template">
  <button
    type="button"
    class:inactive={bypassed}
    disabled={!hasDraft}
    aria-pressed={bypassed}
    aria-label={bypassed ? 'Apply template to this message' : 'Bypass template for this message'}
    aria-keyshortcuts="Control+Alt+B"
    title={bypassed ? 'Template skipped for this message (Ctrl+Alt+B)' : 'Template on (Ctrl+Alt+B to skip once)'}
    onpointerdown={keepComposerFocus}
    onclick={toggleBypass}
  >
    <WandSparkles size={14} strokeWidth={1.8} aria-hidden="true" />
    <span>{bypassed ? 'Template skipped' : 'Template on'}</span>
  </button>
  <PopoverShell
    open={previewOpen}
    onOpenChange={handlePreviewOpenChange}
    side="top"
    align="end"
    sideOffset={7}
    trapFocus={false}
    contentClass="composer-template-popover"
    triggerClass="composer-preview-button"
    triggerLabel="Preview final message"
    triggerTitle="Preview the final message (Ctrl+Alt+P)"
    triggerDisabled={!hasDraft}
    triggerAriaKeyShortcuts="Control+Alt+P"
    onInteractOutside={handleInteractOutside}
    onOpenAutoFocus={focusPreview}
    onCloseAutoFocus={preventPopoverAutoFocus}
  >
    {#snippet trigger()}
      <Eye size={14} strokeWidth={1.8} aria-hidden="true" />
      <span>Preview</span>
    {/snippet}
    {#snippet children()}
      <section class="template-preview" aria-labelledby="composer-template-preview-title" data-vampire-overlay>
        <header>
          <h2 id="composer-template-preview-title">Final message preview</h2>
          <button
            bind:this={previewCloseElement}
            type="button"
            class="template-preview-close"
            onclick={closePreview}
            aria-label="Close final message preview"
          >
            <X size={16} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </header>
        <p class="template-preview-state">
          {bypassed ? 'The template is skipped for this message.' : 'This is the exact text Compose will submit.'}
        </p>
        {#if previewWarning}
          <p class="template-preview-warning" role="status">{previewWarning}</p>
        {/if}
        <pre>{previewText}</pre>
      </section>
    {/snippet}
  </PopoverShell>
</div>

<style>
.composer-template-tools {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  min-width: 0;
}
.composer-template-tools > button,
:global(.composer-preview-button) {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  width: auto;
  min-width: 0;
  height: 1.8rem;
  padding: 0 0.48rem;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-pill);
  background: var(--color-surface-raised);
  color: var(--color-text-secondary);
  font: inherit;
  font-size: var(--text-micro);
  cursor: pointer;
}
.composer-template-tools > button.inactive {
  border-style: dashed;
  color: var(--color-warning-text, var(--color-text-secondary));
}
.composer-template-tools > button:disabled,
:global(.composer-preview-button:disabled) {
  background: transparent;
  color: var(--color-text-disabled);
  cursor: default;
}
@media (hover: hover) {
  .composer-template-tools > button:hover:not(:disabled),
  :global(.composer-preview-button:hover:not(:disabled)) {
    background: var(--color-surface-hover);
    color: var(--color-text);
  }
}
.template-preview {
  display: grid;
  gap: 0.7rem;
  min-width: 0;
}
.template-preview header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}
.template-preview h2 {
  margin: 0;
  color: var(--color-text);
  font-size: var(--text-body);
}
.template-preview .template-preview-close {
  display: grid;
  place-items: center;
  width: 2rem;
  height: 2rem;
  padding: 0;
  border: 0;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
}
:global(.composer-template-popover) {
  box-sizing: border-box;
  z-index: 70;
  width: min(38rem, calc(100vw - 1rem));
  max-height: min(34rem, calc(100dvh - 1rem));
  padding: 0.8rem;
  overflow: hidden;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-md);
  outline: none;
  background: var(--color-surface);
  box-shadow: var(--shadow-popover);
  color: var(--color-text);
}
.template-preview-state,
.template-preview-warning {
  margin: 0;
  color: var(--color-text-secondary);
  font-size: var(--text-caption);
  line-height: var(--leading-ui);
}
.template-preview-warning {
  color: var(--color-warning-text, var(--color-text-secondary));
}
.template-preview pre {
  max-height: min(28rem, 60dvh);
  margin: 0;
  padding: 0.8rem;
  overflow: auto;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-control);
  background: var(--color-terminal-background);
  color: var(--color-terminal-foreground);
  font-family: var(--font-mono);
  font-size: var(--text-caption);
  line-height: var(--leading-body);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
