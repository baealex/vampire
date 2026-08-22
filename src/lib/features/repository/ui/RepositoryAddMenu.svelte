<script lang="ts">
import FilePlus from '@lucide/svelte/icons/file-plus';
import Files from '@lucide/svelte/icons/files';
import FolderPlus from '@lucide/svelte/icons/folder-plus';
import FolderUp from '@lucide/svelte/icons/folder-up';
import Plus from '@lucide/svelte/icons/plus';
import DropdownMenuHeading from '~/lib/shared/ui/DropdownMenuHeading.svelte';
import DropdownMenuItem from '~/lib/shared/ui/DropdownMenuItem.svelte';
import DropdownMenuSeparator from '~/lib/shared/ui/DropdownMenuSeparator.svelte';
import DropdownMenuShell from '~/lib/shared/ui/DropdownMenuShell.svelte';

let {
  disabled = false,
  onCreateFile,
  onCreateFolder,
  onUploadFiles,
  onUploadFolder,
}: {
  disabled?: boolean;
  onCreateFile: () => void;
  onCreateFolder: () => void;
  onUploadFiles: () => void;
  onUploadFolder: () => void;
} = $props();
</script>

<DropdownMenuShell
  triggerLabel="Add workspace item"
  triggerTitle="Add files or folders"
  triggerClass="repository-add-trigger"
  align="end"
>
  {#snippet trigger()}
    <Plus size={18} strokeWidth={1.9} aria-hidden="true" />
  {/snippet}

  {#snippet children()}
    <DropdownMenuHeading title="Add to workspace" subtitle="Create or choose" />
    <DropdownMenuSeparator />
    <DropdownMenuItem {disabled} onSelect={onCreateFile}>
      <FilePlus size={16} strokeWidth={1.8} aria-hidden="true" />
      New file
    </DropdownMenuItem>
    <DropdownMenuItem {disabled} onSelect={onCreateFolder}>
      <FolderPlus size={16} strokeWidth={1.8} aria-hidden="true" />
      New folder
    </DropdownMenuItem>
    <DropdownMenuSeparator />
    <DropdownMenuItem {disabled} onSelect={onUploadFiles}>
      <Files size={16} strokeWidth={1.8} aria-hidden="true" />
      Choose files…
    </DropdownMenuItem>
    <DropdownMenuItem {disabled} onSelect={onUploadFolder}>
      <FolderUp size={16} strokeWidth={1.8} aria-hidden="true" />
      Choose folder…
    </DropdownMenuItem>
  {/snippet}
</DropdownMenuShell>

<style>
:global(.repository-add-trigger) {
  display: grid;
  place-items: center;
  width: var(--control-height-md);
  height: var(--control-height-md);
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
}
:global(.repository-add-trigger:focus-visible),
:global(.repository-add-trigger[data-state="open"]) {
  border-color: var(--color-border);
  background: var(--color-surface-selected);
  color: var(--color-text);
}
@media (hover: hover) {
  :global(.repository-add-trigger:hover) {
    border-color: var(--color-border);
    background: var(--color-surface-selected);
    color: var(--color-text);
  }
}
</style>
