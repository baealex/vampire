<script lang="ts">
import Ellipsis from '@lucide/svelte/icons/ellipsis';
import FilePlus from '@lucide/svelte/icons/file-plus';
import FolderPlus from '@lucide/svelte/icons/folder-plus';
import SquareTerminal from '@lucide/svelte/icons/square-terminal';
import Trash2 from '@lucide/svelte/icons/trash-2';
import Copy from '@lucide/svelte/icons/copy';
import ClipboardPaste from '@lucide/svelte/icons/clipboard-paste';
import Pencil from '@lucide/svelte/icons/pencil';
import Scissors from '@lucide/svelte/icons/scissors';
import DropdownMenuHeading from '~/lib/shared/ui/DropdownMenuHeading.svelte';
import DropdownMenuItem from '~/lib/shared/ui/DropdownMenuItem.svelte';
import DropdownMenuSeparator from '~/lib/shared/ui/DropdownMenuSeparator.svelte';
import DropdownMenuShell from '~/lib/shared/ui/DropdownMenuShell.svelte';
import type { WorkspaceEntryKind } from '~/lib/shared/contracts/repository';

let {
  path,
  kind,
  open = false,
  onOpenChange,
  onCreateFile,
  onCreateFolder,
  onInsertPath,
  selectedCount = 1,
  canPaste = false,
  onRename,
  onCopy,
  onCut,
  onPaste,
  onDelete,
}: {
  path: string;
  kind: WorkspaceEntryKind;
  open?: boolean;
  onOpenChange: (open: boolean) => void;
  onCreateFile: () => void;
  onCreateFolder: () => void;
  onInsertPath: () => void;
  selectedCount?: number;
  canPaste?: boolean;
  onRename: () => void;
  onCopy: () => void;
  onCut: () => void;
  onPaste: () => void;
  onDelete: () => void;
} = $props();

const name = $derived(path.split('/').pop() || path);
</script>

<DropdownMenuShell
  {open}
  {onOpenChange}
  triggerLabel={`Actions for ${kind === 'directory' ? 'folder' : 'file'} ${path}`}
  triggerTitle="More actions"
  triggerClass="repository-entry-menu-trigger"
  align="end"
>
  {#snippet trigger()}
    <Ellipsis size={16} strokeWidth={1.9} aria-hidden="true" />
  {/snippet}

  {#snippet children()}
    <DropdownMenuHeading
      title={selectedCount > 1 ? `${selectedCount} selected` : name}
      subtitle={kind === 'directory' ? 'Folder actions' : 'File actions'}
    />
    <DropdownMenuSeparator />
    {#if kind === 'directory'}
      <DropdownMenuItem onSelect={onCreateFile}>
        <FilePlus size={16} strokeWidth={1.8} aria-hidden="true" />
        New file
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={onCreateFolder}>
        <FolderPlus size={16} strokeWidth={1.8} aria-hidden="true" />
        New folder
      </DropdownMenuItem>
      <DropdownMenuSeparator />
    {/if}
    <DropdownMenuItem disabled={selectedCount !== 1} onSelect={onRename}>
      <Pencil size={16} strokeWidth={1.8} aria-hidden="true" />
      Rename
    </DropdownMenuItem>
    <DropdownMenuItem onSelect={onCopy}>
      <Copy size={16} strokeWidth={1.8} aria-hidden="true" />
      Copy
    </DropdownMenuItem>
    <DropdownMenuItem onSelect={onCut}>
      <Scissors size={16} strokeWidth={1.8} aria-hidden="true" />
      Cut
    </DropdownMenuItem>
    {#if kind === 'directory'}
      <DropdownMenuItem disabled={!canPaste} onSelect={onPaste}>
        <ClipboardPaste size={16} strokeWidth={1.8} aria-hidden="true" />
        Paste into folder
      </DropdownMenuItem>
    {/if}
    <DropdownMenuSeparator />
    <DropdownMenuItem onSelect={onInsertPath}>
      <SquareTerminal size={16} strokeWidth={1.8} aria-hidden="true" />
      Insert path into terminal
    </DropdownMenuItem>
    <DropdownMenuSeparator />
    <DropdownMenuItem tone="danger" onSelect={onDelete}>
      <Trash2 size={16} strokeWidth={1.8} aria-hidden="true" />
      Delete
    </DropdownMenuItem>
  {/snippet}
</DropdownMenuShell>

<style>
:global(.repository-entry-menu-trigger) {
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
:global(.repository-entry-menu-trigger:focus-visible),
:global(.repository-entry-menu-trigger[data-state="open"]) {
  background: var(--color-control-hover);
  color: var(--color-text);
}
@media (hover: hover) {
  :global(.repository-entry-menu-trigger:hover) {
    background: var(--color-control-hover);
    color: var(--color-text);
  }
}
</style>
