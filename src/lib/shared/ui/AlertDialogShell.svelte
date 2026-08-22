<script lang="ts">
import { AlertDialog } from 'bits-ui';
import X from '@lucide/svelte/icons/x';
import DialogChrome from './DialogChrome.svelte';
import type { Snippet } from 'svelte';
import { focusFirstOverlayInput } from './overlay.ts';

let {
  eyebrow,
  title,
  close,
  closeDisabled = false,
  children,
  footer,
}: {
  eyebrow?: string;
  title: string;
  close: () => void;
  closeDisabled?: boolean;
  children?: Snippet;
  footer?: Snippet;
} = $props();

let contentElement = $state<HTMLElement | null>(null);

function handleOpenChange(open: boolean) {
  if (!open && !closeDisabled) close();
}

function handleOpenAutoFocus(event: Event) {
  focusFirstOverlayInput(contentElement, event);
}
</script>

<AlertDialog.Root open={true} onOpenChange={handleOpenChange}>
  <AlertDialog.Portal>
    <AlertDialog.Overlay class="vampire-dialog-overlay vampire-alert-dialog-overlay" />
    <AlertDialog.Content
      bind:ref={contentElement}
      data-vampire-overlay
      class="vampire-dialog-content vampire-alert-dialog-content"
      onOpenAutoFocus={handleOpenAutoFocus}
      escapeKeydownBehavior={closeDisabled ? 'ignore' : 'close'}
    >
      <DialogChrome {eyebrow} {children} {footer}>
        {#snippet titleContent()}
          <AlertDialog.Title class="vampire-dialog-title">{title}</AlertDialog.Title>
        {/snippet}
        {#snippet closeContent()}
          <AlertDialog.Cancel class="vampire-dialog-close" disabled={closeDisabled} aria-label="Close">
            <X size={18} strokeWidth={1.8} aria-hidden="true" />
          </AlertDialog.Cancel>
        {/snippet}
      </DialogChrome>
    </AlertDialog.Content>
  </AlertDialog.Portal>
</AlertDialog.Root>
