<script lang="ts">
import FilePlus from '@lucide/svelte/icons/file-plus';
import FolderPlus from '@lucide/svelte/icons/folder-plus';
import Plus from '@lucide/svelte/icons/plus';
import DropdownMenuHeading from '~/lib/shared/ui/DropdownMenuHeading.svelte';
import DropdownMenuItem from '~/lib/shared/ui/DropdownMenuItem.svelte';
import DropdownMenuSeparator from '~/lib/shared/ui/DropdownMenuSeparator.svelte';
import DropdownMenuShell from '~/lib/shared/ui/DropdownMenuShell.svelte';

let {
  path,
  onCreateFile,
  onCreateFolder,
}: {
  path: string;
  onCreateFile: () => void;
  onCreateFolder: () => void;
} = $props();

const name = $derived(path.split('/').pop() || path);
</script>

<DropdownMenuShell
  triggerLabel={`Add inside ${path}`}
  triggerTitle={`Add inside ${path}`}
  triggerClass="repository-directory-add-trigger"
  align="end"
>
  {#snippet trigger()}
    <Plus size={15} strokeWidth={2} aria-hidden="true" />
  {/snippet}

  {#snippet children()}
    <DropdownMenuHeading title={`Add inside ${name}`} subtitle={path} />
    <DropdownMenuSeparator />
    <DropdownMenuItem onSelect={onCreateFile}>
      <FilePlus size={16} strokeWidth={1.8} aria-hidden="true" />
      New file
    </DropdownMenuItem>
    <DropdownMenuItem onSelect={onCreateFolder}>
      <FolderPlus size={16} strokeWidth={1.8} aria-hidden="true" />
      New folder
    </DropdownMenuItem>
  {/snippet}
</DropdownMenuShell>

<style>
:global(.repository-directory-add-trigger) {
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
:global(.repository-directory-add-trigger:focus-visible),
:global(.repository-directory-add-trigger[data-state="open"]) {
  background: var(--color-control-hover);
  color: var(--color-text);
}
@media (hover: hover) {
  :global(.repository-directory-add-trigger:hover) {
    background: var(--color-control-hover);
    color: var(--color-text);
  }
}
</style>
