<script lang="ts">
import { AlertDialog } from 'bits-ui';
import X from '@lucide/svelte/icons/x';
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
      <header class="vampire-dialog-header">
        <div class="vampire-dialog-heading">
          <div class="vampire-dialog-heading-copy">
            {#if eyebrow}
              <p class="vampire-dialog-eyebrow">{eyebrow}</p>
            {/if}
            <AlertDialog.Title class="vampire-dialog-title">{title}</AlertDialog.Title>
          </div>
        </div>
        <AlertDialog.Cancel class="vampire-dialog-close" disabled={closeDisabled} aria-label="Close">
          <X size={18} strokeWidth={1.8} aria-hidden="true" />
        </AlertDialog.Cancel>
      </header>
      <div class="vampire-dialog-body">
        {@render children?.()}
      </div>
      {#if footer}
        <footer class="vampire-dialog-footer">
          {@render footer()}
        </footer>
      {/if}
    </AlertDialog.Content>
  </AlertDialog.Portal>
</AlertDialog.Root>
