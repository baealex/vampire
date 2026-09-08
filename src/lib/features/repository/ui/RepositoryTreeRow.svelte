<script lang="ts">
import ChevronDown from '@lucide/svelte/icons/chevron-down';
import ChevronRight from '@lucide/svelte/icons/chevron-right';
import FileText from '@lucide/svelte/icons/file-text';
import Folder from '@lucide/svelte/icons/folder';
import FolderOpen from '@lucide/svelte/icons/folder-open';
import ImageIcon from '@lucide/svelte/icons/image';
import type { FileTreeRow, WorkspaceEntryKind } from '~/lib/shared/contracts/repository.ts';
import { isPreviewableImage } from '../model/view.ts';
import RepositoryDirectoryAddMenu from './RepositoryDirectoryAddMenu.svelte';
import RepositoryEntryMenu from './RepositoryEntryMenu.svelte';

let {
  row,
  changeKind,
  gitIgnored = false,
  expanded = false,
  loading = false,
  selected = false,
  dragging = false,
  dropCandidate = false,
  dropTarget = false,
  cut = false,
  entryMenuOpen = false,
  selectedCount = 1,
  canPaste = false,
  onContextMenu,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragStart,
  onDragEnd,
  onSelect,
  onKeydown,
  onEntryMenuOpenChange,
  onCreateFile,
  onCreateFolder,
  onInsertPath,
  onRename,
  onCopy,
  onCut,
  onPaste,
  onDelete,
}: {
  row: FileTreeRow;
  changeKind?: 'added' | 'modified';
  gitIgnored?: boolean;
  expanded?: boolean;
  loading?: boolean;
  selected?: boolean;
  dragging?: boolean;
  dropCandidate?: boolean;
  dropTarget?: boolean;
  cut?: boolean;
  entryMenuOpen?: boolean;
  selectedCount?: number;
  canPaste?: boolean;
  onContextMenu: (event: MouseEvent) => void;
  onDragOver: (event: DragEvent) => void;
  onDragLeave: (event: DragEvent) => void;
  onDrop: (event: DragEvent) => void;
  onDragStart: (event: DragEvent) => void;
  onDragEnd: () => void;
  onSelect: (event: MouseEvent) => void;
  onKeydown: (event: KeyboardEvent) => void;
  onEntryMenuOpenChange: (open: boolean) => void;
  onCreateFile: () => void;
  onCreateFolder: () => void;
  onInsertPath: () => void;
  onRename: () => void;
  onCopy: () => void;
  onCut: () => void;
  onPaste: () => void;
  onDelete: () => void;
} = $props();

const kind: WorkspaceEntryKind = $derived(row.kind);
</script>

<!-- biome-ignore lint/a11y/useSemanticElements: A tree row group is not a form fieldset. -->
<div
  class="tree-row-shell"
  role="group"
  class:directory={row.kind === 'directory'}
  class:dragging={dragging}
  class:drop-candidate={dropCandidate}
  class:drop-target={dropTarget}
  class:ignored={gitIgnored}
  class:cut={cut}
  class:selected={selected}
  oncontextmenu={onContextMenu}
  data-tree-path={row.path}
  data-tree-kind={row.kind}
  ondragover={onDragOver}
  ondragleave={onDragLeave}
  ondrop={onDrop}
>
  <button
    type="button"
    class="tree-row"
    class:modified={changeKind === 'modified'}
    class:added={changeKind === 'added'}
    draggable={true}
    data-tree-path={row.path}
    ondragstart={onDragStart}
    ondragend={onDragEnd}
    onclick={onSelect}
    onkeydown={onKeydown}
    aria-busy={row.kind === 'directory' && loading}
    aria-expanded={row.kind === 'directory' ? expanded : undefined}
    aria-label={`${row.kind === 'directory' ? `${expanded ? 'Collapse' : 'Expand'} ${row.path}` : `Open ${row.path}`}${gitIgnored ? ', ignored by Git' : ''}`}
  >
    <span class="tree-indent" aria-hidden="true">
      {#each Array(row.depth + 1) as _}
        <span></span>
      {/each}
    </span>
    {#if row.kind === 'directory'}
      <span class="tree-chevron" aria-hidden="true">
        {#if expanded}
          <ChevronDown size={14} strokeWidth={1.8} />
        {:else}
          <ChevronRight size={14} strokeWidth={1.8} />
        {/if}
      </span>
      <span
        class="tree-icon"
        class:modified={changeKind === 'modified'}
        class:added={changeKind === 'added'}
        aria-hidden="true"
      >
        {#if expanded}
          <FolderOpen size={15} strokeWidth={1.7} />
        {:else}
          <Folder size={15} strokeWidth={1.7} />
        {/if}
      </span>
    {:else}
      <span class="tree-chevron" aria-hidden="true"></span>
      <span
        class="tree-icon file"
        class:image={isPreviewableImage(row.path)}
        class:modified={changeKind === 'modified'}
        class:added={changeKind === 'added'}
        aria-hidden="true"
      >
        {#if isPreviewableImage(row.path)}
          <ImageIcon size={15} strokeWidth={1.6} />
        {:else}
          <FileText size={15} strokeWidth={1.6} />
        {/if}
      </span>
    {/if}
    <span class="tree-name" title={row.path}>{row.name}</span>
  </button>
  <div class="tree-actions" class:open={entryMenuOpen}>
    {#if row.kind === 'directory'}
      <RepositoryDirectoryAddMenu path={row.path} {onCreateFile} {onCreateFolder} />
    {/if}
    <RepositoryEntryMenu
      path={row.path}
      {kind}
      open={entryMenuOpen}
      onOpenChange={onEntryMenuOpenChange}
      {onCreateFile}
      {onCreateFolder}
      {onInsertPath}
      {selectedCount}
      {canPaste}
      {onRename}
      {onCopy}
      {onCut}
      {onPaste}
      {onDelete}
    />
  </div>
</div>

<style>
.tree-row-shell {
  display: flex;
  align-items: center;
  min-width: 0;
  min-height: 2rem;
  border-bottom: 1px solid transparent;
}
.tree-row-shell.selected {
  background: var(--color-surface-active);
}
.tree-row-shell.dragging {
  opacity: 0.45;
}
.tree-row-shell.cut {
  opacity: 0.55;
}
.tree-row-shell.drop-candidate {
  box-shadow: inset 2px 0 0 color-mix(in srgb, var(--color-accent) 38%, transparent);
}
.tree-row-shell.drop-target {
  background: var(--color-accent-soft);
  box-shadow:
    inset 0 0 0 1px var(--color-accent),
    inset 3px 0 0 var(--color-accent);
}
.tree-row {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  width: 0;
  min-width: 0;
  min-height: 2rem;
  padding: 0 0.2rem 0 0.65rem;
  border: 0;
  background: transparent;
  color: var(--color-text-secondary);
  text-align: left;
  cursor: pointer;
}
.tree-row-shell.dragging .tree-row {
  cursor: grabbing;
}
.tree-row-shell.selected .tree-row {
  color: var(--color-text);
}
.tree-row-shell.ignored .tree-row {
  opacity: 0.48;
}
.tree-row-shell.ignored:focus-within .tree-row {
  opacity: 0.68;
}
.tree-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  padding-right: 0.35rem;
  opacity: 0;
}
.tree-row-shell:focus-within .tree-actions,
.tree-actions.open {
  opacity: 1;
}
.tree-indent {
  display: inline-flex;
  flex: 0 0 auto;
}
.tree-indent > span {
  width: 0.72rem;
}
.tree-chevron {
  display: grid;
  flex: 0 0 1rem;
  place-items: center;
  width: 1rem;
  color: var(--color-text-tertiary);
}
.tree-icon {
  display: grid;
  flex: 0 0 1.35rem;
  place-items: center;
  width: 1.35rem;
  color: var(--color-folder);
}
.tree-icon.file {
  color: var(--color-text-tertiary);
}
.tree-icon.file.image {
  color: var(--color-image);
}
.tree-row-shell.drop-target .tree-row,
.tree-row-shell.drop-target .tree-icon {
  color: var(--color-accent-soft-text);
}
.tree-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: var(--text-caption);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tree-row.modified,
.tree-row-shell.selected .tree-row.modified,
.tree-row.modified .tree-icon {
  color: var(--color-warning);
}
.tree-row.added,
.tree-row-shell.selected .tree-row.added,
.tree-row.added .tree-icon {
  color: var(--color-info);
}

@media (hover: hover) {
  .tree-row-shell:hover {
    background: var(--color-surface-raised);
  }
  .tree-row:hover {
    color: var(--color-text);
  }
  .tree-row-shell.ignored:hover .tree-row {
    opacity: 0.68;
  }
  .tree-row-shell:hover .tree-actions {
    opacity: 1;
  }
  .tree-row.modified:hover,
  .tree-row-shell.selected .tree-row.modified:hover {
    color: var(--color-warning);
  }
  .tree-row.added:hover,
  .tree-row-shell.selected .tree-row.added:hover {
    color: var(--color-info);
  }
}

@media (hover: none) {
  .tree-actions {
    opacity: 1;
  }
}
</style>
