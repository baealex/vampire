<script lang="ts">
import { Dialog } from 'bits-ui';
import X from '@lucide/svelte/icons/x';
import DialogChrome from './DialogChrome.svelte';
import type { Snippet } from 'svelte';
import { focusFirstOverlayInput } from './overlay.ts';

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

let contentElement = $state<HTMLElement | null>(null);

function handleOpenChange(open: boolean) {
  if (!open && !closeDisabled) close();
}

function handleOpenAutoFocus(event: Event) {
  focusFirstOverlayInput(contentElement, event);
}
</script>

<Dialog.Root open={true} onOpenChange={handleOpenChange}>
  <Dialog.Portal>
    <Dialog.Overlay class="vampire-dialog-overlay" />
    <Dialog.Content
      bind:ref={contentElement}
      id={contentId}
      data-vampire-overlay
      class={`vampire-dialog-content${variant === 'default' ? '' : ` vampire-dialog-content--${variant}`}`}
      onOpenAutoFocus={handleOpenAutoFocus}
      {onCloseAutoFocus}
      escapeKeydownBehavior={closeDisabled ? 'ignore' : 'close'}
      interactOutsideBehavior={closeDisabled ? 'ignore' : 'close'}
    >
      <DialogChrome {eyebrow} {onBack} backDisabled={closeDisabled} {backLabel} {children} {footer} {footerVisible}>
        {#snippet titleContent()}
          <Dialog.Title class="vampire-dialog-title">{title}</Dialog.Title>
        {/snippet}
        {#snippet closeContent()}
          <Dialog.Close class="vampire-dialog-close" disabled={closeDisabled} aria-label={closeLabel}>
            <X size={18} strokeWidth={1.8} aria-hidden="true" />
          </Dialog.Close>
        {/snippet}
      </DialogChrome>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
