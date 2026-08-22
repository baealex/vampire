<script lang="ts">
import { DropdownMenu } from 'bits-ui';
import FilePlus from '@lucide/svelte/icons/file-plus';
import Files from '@lucide/svelte/icons/files';
import FolderPlus from '@lucide/svelte/icons/folder-plus';
import FolderUp from '@lucide/svelte/icons/folder-up';
import Plus from '@lucide/svelte/icons/plus';
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
    <div class="vampire-menu-heading" role="presentation">
      <strong>Add to workspace</strong>
      <span>Create or choose</span>
    </div>
    <DropdownMenu.Separator class="vampire-menu-separator" />
    <DropdownMenu.Item class="vampire-menu-item" {disabled} onSelect={onCreateFile}>
      <FilePlus size={16} strokeWidth={1.8} aria-hidden="true" />
      New file
    </DropdownMenu.Item>
    <DropdownMenu.Item class="vampire-menu-item" {disabled} onSelect={onCreateFolder}>
      <FolderPlus size={16} strokeWidth={1.8} aria-hidden="true" />
      New folder
    </DropdownMenu.Item>
    <DropdownMenu.Separator class="vampire-menu-separator" />
    <DropdownMenu.Item class="vampire-menu-item" {disabled} onSelect={onUploadFiles}>
      <Files size={16} strokeWidth={1.8} aria-hidden="true" />
      Choose files…
    </DropdownMenu.Item>
    <DropdownMenu.Item class="vampire-menu-item" {disabled} onSelect={onUploadFolder}>
      <FolderUp size={16} strokeWidth={1.8} aria-hidden="true" />
      Choose folder…
    </DropdownMenu.Item>
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
