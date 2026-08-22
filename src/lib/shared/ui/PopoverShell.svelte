<script lang="ts">
import { Popover } from 'bits-ui';
import type { Snippet } from 'svelte';

let {
  open = $bindable(false),
  onOpenChange = () => undefined,
  side = 'bottom',
  align = 'center',
  sideOffset = 4,
  alignOffset = 0,
  trapFocus = true,
  onInteractOutside,
  onCloseAutoFocus,
  contentEnabled = true,
  contentClass,
  triggerClass,
  triggerLabel,
  triggerTitle,
  triggerTone,
  trigger,
  children,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
  alignOffset?: number;
  trapFocus?: boolean;
  onInteractOutside?: (event: Event) => void;
  onCloseAutoFocus?: (event: Event) => void;
  contentEnabled?: boolean;
  contentClass?: string;
  triggerClass?: string;
  triggerLabel?: string;
  triggerTitle?: string;
  triggerTone?: string;
  trigger?: Snippet;
  children?: Snippet;
} = $props();

function handleOpenChange(nextOpen: boolean) {
  open = nextOpen;
  onOpenChange(nextOpen);
}
</script>

<Popover.Root bind:open onOpenChange={handleOpenChange}>
  <Popover.Trigger
    type="button"
    class={triggerClass}
    aria-label={triggerLabel}
    title={triggerTitle}
    data-tone={triggerTone}
  >
    {@render trigger?.()}
  </Popover.Trigger>
  {#if contentEnabled}
    <Popover.Portal>
      <Popover.Content
        class={contentClass}
        {side}
        {align}
        {sideOffset}
        {alignOffset}
        {trapFocus}
        {onInteractOutside}
        {onCloseAutoFocus}
      >
        {@render children?.()}
      </Popover.Content>
    </Popover.Portal>
  {/if}
</Popover.Root>
