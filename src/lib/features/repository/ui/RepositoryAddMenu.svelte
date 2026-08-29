<script lang="ts">
import FilePlus from '@lucide/svelte/icons/file-plus';
import Files from '@lucide/svelte/icons/files';
import FolderPlus from '@lucide/svelte/icons/folder-plus';
import FolderUp from '@lucide/svelte/icons/folder-up';
import Plus from '@lucide/svelte/icons/plus';
import ClipboardPaste from '@lucide/svelte/icons/clipboard-paste';
import DropdownMenuHeading from '~/lib/shared/ui/DropdownMenuHeading.svelte';
import DropdownMenuItem from '~/lib/shared/ui/DropdownMenuItem.svelte';
import DropdownMenuSeparator from '~/lib/shared/ui/DropdownMenuSeparator.svelte';
import DropdownMenuShell from '~/lib/shared/ui/DropdownMenuShell.svelte';

let {
  disabled = false,
  targetDirectory = '',
  rootPath = '',
  canPaste = false,
  onCreateFile,
  onCreateFolder,
  onUploadFiles,
  onUploadFolder,
  onPaste,
}: {
  disabled?: boolean;
  targetDirectory?: string;
  rootPath?: string;
  canPaste?: boolean;
  onCreateFile: () => void;
  onCreateFolder: () => void;
  onUploadFiles: () => void;
  onUploadFolder: () => void;
  onPaste: () => void;
} = $props();

const targetName = $derived(targetDirectory || 'workspace root');
</script>

<DropdownMenuShell
  triggerLabel={`Add inside ${targetName}`}
  triggerTitle={`Add inside ${targetName}`}
  triggerClass="repository-add-trigger"
  align="end"
>
  {#snippet trigger()}
    <Plus size={15} strokeWidth={2} aria-hidden="true" />
  {/snippet}

  {#snippet children()}
    <DropdownMenuHeading
      title={`Add inside ${targetName}`}
      subtitle={targetDirectory || rootPath || 'Workspace root'}
    />
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
      Upload files…
    </DropdownMenuItem>
    <DropdownMenuItem {disabled} onSelect={onUploadFolder}>
      <FolderUp size={16} strokeWidth={1.8} aria-hidden="true" />
      Upload folder…
    </DropdownMenuItem>
    <DropdownMenuSeparator />
    <DropdownMenuItem disabled={disabled || !canPaste} onSelect={onPaste}>
      <ClipboardPaste size={16} strokeWidth={1.8} aria-hidden="true" />
      Paste
    </DropdownMenuItem>
  {/snippet}
</DropdownMenuShell>

<style>
:global(.repository-add-trigger) {
  display: grid;
  place-items: center;
  width: 1.8rem;
  height: 1.8rem;
  padding: 0;
  border: 0;
  border-radius: 0.35rem;
  background: transparent;
  color: var(--color-text-tertiary);
  cursor: pointer;
}
:global(.repository-add-trigger:focus-visible),
:global(.repository-add-trigger[data-state="open"]) {
  background: var(--color-control-hover);
  color: var(--color-text);
}
@media (hover: hover) {
  :global(.repository-add-trigger:hover) {
    background: var(--color-control-hover);
    color: var(--color-text);
  }
}
</style>
