<script lang="ts">
import { DropdownMenu } from 'bits-ui';
import type { Snippet } from 'svelte';

let {
  open = $bindable(false),
  onOpenChange = () => undefined,
  triggerLabel,
  triggerTitle,
  triggerClass = 'vampire-menu-trigger',
  align = 'start',
  trigger,
  children,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  triggerLabel: string;
  triggerTitle?: string;
  triggerClass?: string;
  align?: 'start' | 'center' | 'end';
  trigger?: Snippet;
  children?: Snippet;
} = $props();

function handleOpenChange(nextOpen: boolean) {
  open = nextOpen;
  onOpenChange(nextOpen);
}
</script>

<DropdownMenu.Root bind:open onOpenChange={handleOpenChange}>
  <DropdownMenu.Trigger class={triggerClass} aria-label={triggerLabel} title={triggerTitle}>
    {@render trigger?.()}
  </DropdownMenu.Trigger>
  <DropdownMenu.Portal>
    <DropdownMenu.Content data-vampire-overlay class="vampire-menu-content" sideOffset={6} {align}>
      {@render children?.()}
    </DropdownMenu.Content>
  </DropdownMenu.Portal>
</DropdownMenu.Root>
