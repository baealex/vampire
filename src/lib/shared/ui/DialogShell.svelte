<script lang="ts">
import { Dialog } from 'bits-ui';
import ArrowLeft from '@lucide/svelte/icons/arrow-left';
import X from '@lucide/svelte/icons/x';
import type { Snippet } from 'svelte';

let {
  eyebrow,
  title,
  close,
  closeDisabled = false,
  variant = 'default',
  contentId,
  closeLabel = 'Close',
  onBack,
  backLabel = 'Back',
  onCloseAutoFocus,
  children,
  footer,
  footerVisible = true,
}: {
  eyebrow?: string;
  title: string;
  close: () => void;
  closeDisabled?: boolean;
  variant?: 'default' | 'form' | 'inspect';
  contentId?: string;
  closeLabel?: string;
  onBack?: () => void;
  backLabel?: string;
  onCloseAutoFocus?: (event: Event) => void;
  children?: Snippet;
  footer?: Snippet;
  footerVisible?: boolean;
} = $props();

function handleOpenChange(open: boolean) {
  if (!open && !closeDisabled) close();
}
</script>

<Dialog.Root open={true} onOpenChange={handleOpenChange}>
  <Dialog.Portal>
    <Dialog.Overlay class="vampire-dialog-overlay" />
    <Dialog.Content
      id={contentId}
      data-vampire-overlay
      class={`vampire-dialog-content${variant === 'default' ? '' : ` vampire-dialog-content--${variant}`}`}
      {onCloseAutoFocus}
      escapeKeydownBehavior={closeDisabled ? 'ignore' : 'close'}
      interactOutsideBehavior={closeDisabled ? 'ignore' : 'close'}
    >
      <header class="vampire-dialog-header">
        <div class="vampire-dialog-heading">
          {#if onBack}
            <button
              type="button"
              class="vampire-dialog-back"
              onclick={onBack}
              disabled={closeDisabled}
              aria-label={backLabel}
            >
              <ArrowLeft size={18} strokeWidth={1.8} aria-hidden="true" />
            </button>
          {/if}
          <div class="vampire-dialog-heading-copy">
            {#if eyebrow}
              <p class="vampire-dialog-eyebrow">{eyebrow}</p>
            {/if}
            <Dialog.Title class="vampire-dialog-title">{title}</Dialog.Title>
          </div>
        </div>
        <Dialog.Close class="vampire-dialog-close" disabled={closeDisabled} aria-label={closeLabel}>
          <X size={18} strokeWidth={1.8} aria-hidden="true" />
        </Dialog.Close>
      </header>
      <div class="vampire-dialog-body">
        {@render children?.()}
      </div>
      {#if footer && footerVisible}
        <footer class="vampire-dialog-footer">
          {@render footer()}
        </footer>
      {/if}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
