<script lang="ts">
import ChevronsDownUp from '@lucide/svelte/icons/chevrons-down-up';
import Ellipsis from '@lucide/svelte/icons/ellipsis';
import DropdownMenuItem from '~/lib/shared/ui/DropdownMenuItem.svelte';
import DropdownMenuShell from '~/lib/shared/ui/DropdownMenuShell.svelte';

let {
  canCollapse,
  onCollapseAll,
  onOpenChange = () => undefined,
}: {
  canCollapse: boolean;
  onCollapseAll: () => void;
  onOpenChange?: (open: boolean) => void;
} = $props();
</script>

<DropdownMenuShell
  triggerLabel="More workspace tree actions"
  triggerTitle="More workspace tree actions"
  triggerClass="repository-tree-actions-trigger"
  align="end"
  {onOpenChange}
>
  {#snippet trigger()}
    <Ellipsis size={16} strokeWidth={2} aria-hidden="true" />
  {/snippet}

  {#snippet children()}
    <DropdownMenuItem disabled={!canCollapse} onSelect={onCollapseAll}>
      <ChevronsDownUp size={16} strokeWidth={1.8} aria-hidden="true" />
      Collapse all folders
    </DropdownMenuItem>
  {/snippet}
</DropdownMenuShell>

<style>
:global(.repository-tree-actions-trigger) {
  width: 1.8rem;
  height: 1.8rem;
  border-radius: 0.35rem;
}
</style>
