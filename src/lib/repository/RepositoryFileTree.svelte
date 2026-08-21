<script lang="ts">
import ChevronDown from '@lucide/svelte/icons/chevron-down';
import ChevronRight from '@lucide/svelte/icons/chevron-right';
import FileText from '@lucide/svelte/icons/file-text';
import Folder from '@lucide/svelte/icons/folder';
import FolderOpen from '@lucide/svelte/icons/folder-open';
import ImageIcon from '@lucide/svelte/icons/image';
import {
  parseWorkspaceEntryDrag,
  WORKSPACE_ENTRY_DRAG_TYPE,
  workspaceEntryCanMoveToDirectory,
  workspaceEntryDragText,
  type WorkspaceEntryDragData,
} from '$lib/workspace-entry-drag.ts';
import RepositoryEntryMenu from './RepositoryEntryMenu.svelte';
import RepositoryInlineEntry from './RepositoryInlineEntry.svelte';
import { dataTransferHasUploadFiles } from './upload';
import { buildChangeKindMap, buildVisibleFileTree, isPreviewableImage } from './view';
import type { RepositorySelection, RepositorySnapshot, WorkspaceMoveResult } from './types';

let {
  snapshot,
  selected,
  onLoadDirectory,
  onCreateFile,
  onCreateDirectory,
  onRequestDelete,
  rootCreationRequest,
  onDropFiles,
  onMoveEntry,
  onInsertPath,
  dropOperation = '',
  onSelect,
}: {
  snapshot: RepositorySnapshot;
  selected?: RepositorySelection;
  onLoadDirectory: (path: string) => Promise<void>;
  onCreateFile: (directory: string, name: string) => Promise<void>;
  onCreateDirectory: (directory: string, name: string) => Promise<void>;
  onRequestDelete: (path: string, kind: 'file' | 'directory') => void;
  rootCreationRequest?: { kind: 'file' | 'directory'; token: number };
  onDropFiles: (directory: string, dataTransfer: DataTransfer) => Promise<void>;
  onMoveEntry: (entry: WorkspaceEntryDragData, directory: string) => Promise<WorkspaceMoveResult | undefined>;
  onInsertPath: (entry: WorkspaceEntryDragData) => void;
  dropOperation?: '' | 'copy' | 'move';
  onSelect: (selection: RepositorySelection) => void;
} = $props();

let expandedDirectories = $state<string[]>([]);
let inlineCreation = $state<{ kind: 'file' | 'directory'; parent: string }>();
let creationName = $state('');
let creationError = $state('');
let creating = $state(false);
let loadingDirectories = $state<string[]>([]);
let draggingPath = $state('');
let draggingEntry = $state<WorkspaceEntryDragData>();
let dropTargetDirectory = $state('');
let dropTargetOperation = $state<'' | 'copy' | 'move'>('');
let entryMenuPath = $state('');
let treeRows = $derived(buildVisibleFileTree(snapshot.files, expandedDirectories, snapshot.directories));
let changeKinds = $derived(buildChangeKindMap(snapshot.changes));
let ignoredPaths = $derived(new Set(snapshot.ignored));
let revealRequestPath = '';
let revealRequestId = 0;
let handledCreationToken = 0;

function beginEntryDrag(event: DragEvent, path: string, kind: 'file' | 'directory') {
  if (!event.dataTransfer) return;
  const entry = { path, kind };
  event.dataTransfer.effectAllowed = 'copyMove';
  event.dataTransfer.setData(WORKSPACE_ENTRY_DRAG_TYPE, JSON.stringify(entry));
  event.dataTransfer.setData('text/plain', workspaceEntryDragText(entry));
  draggingPath = path;
  draggingEntry = entry;
}

function endEntryDrag() {
  draggingPath = '';
  draggingEntry = undefined;
  dropTargetDirectory = '';
  dropTargetOperation = '';
}

function handleDirectoryDragOver(event: DragEvent, path: string) {
  const dataTransfer = event.dataTransfer;
  if (!dataTransfer) return;
  if (dataTransferHasUploadFiles(dataTransfer)) {
    event.preventDefault();
    dataTransfer.dropEffect = 'copy';
    dropTargetDirectory = path;
    dropTargetOperation = 'copy';
    return;
  }
  if (!Array.from(dataTransfer.types).includes(WORKSPACE_ENTRY_DRAG_TYPE)) return;
  const entry = draggingEntry ?? parseWorkspaceEntryDrag(dataTransfer.getData(WORKSPACE_ENTRY_DRAG_TYPE));
  if (!entry || !workspaceEntryCanMoveToDirectory(entry, path)) return;
  event.preventDefault();
  dataTransfer.dropEffect = 'move';
  dropTargetDirectory = path;
  dropTargetOperation = 'move';
}

function handleDirectoryDragLeave(event: DragEvent, path: string) {
  if (dropTargetDirectory !== path) return;
  event.stopPropagation();
  const current = event.currentTarget;
  const related = event.relatedTarget;
  if (current instanceof Node && related instanceof Node && current.contains(related)) return;
  dropTargetDirectory = '';
  dropTargetOperation = '';
}

function handleDirectoryDrop(event: DragEvent, path: string) {
  const dataTransfer = event.dataTransfer;
  if (!dataTransfer) return;
  if (dataTransferHasUploadFiles(dataTransfer)) {
    event.preventDefault();
    dropTargetDirectory = '';
    dropTargetOperation = '';
    void onDropFiles(path, dataTransfer);
    return;
  }
  if (!Array.from(dataTransfer.types).includes(WORKSPACE_ENTRY_DRAG_TYPE)) return;
  const entry = draggingEntry ?? parseWorkspaceEntryDrag(dataTransfer.getData(WORKSPACE_ENTRY_DRAG_TYPE));
  if (!entry || !workspaceEntryCanMoveToDirectory(entry, path)) return;
  event.preventDefault();
  dropTargetDirectory = '';
  dropTargetOperation = '';
  void moveEntryToDirectory(entry, path);
}

function isDirectoryDropCandidate(path: string): boolean {
  if (!dropOperation) return false;
  if (dropOperation === 'copy' || !draggingEntry) return true;
  return workspaceEntryCanMoveToDirectory(draggingEntry, path);
}

function isGitIgnored(path: string): boolean {
  let candidate = path;
  while (candidate) {
    if (ignoredPaths.has(candidate)) return true;
    const separator = candidate.lastIndexOf('/');
    candidate = separator < 0 ? '' : candidate.slice(0, separator);
  }
  return false;
}

function rebaseExpandedDirectories(result: WorkspaceMoveResult) {
  if (result.kind !== 'directory') return;
  expandedDirectories = expandedDirectories.map((directory) => {
    if (directory === result.fromPath) return result.path;
    if (directory.startsWith(`${result.fromPath}/`)) {
      return `${result.path}${directory.slice(result.fromPath.length)}`;
    }
    return directory;
  });
}

async function moveEntryToDirectory(entry: WorkspaceEntryDragData, path: string) {
  const result = await onMoveEntry(entry, path);
  if (!result) return;
  rebaseExpandedDirectories(result);
  try {
    await onLoadDirectory(path);
    if (!expandedDirectories.includes(path)) expandedDirectories = [...expandedDirectories, path];
  } catch {
    // The move succeeded; the parent panel displays any refresh error.
  }
}

function openEntryMenu(event: MouseEvent, path: string) {
  event.preventDefault();
  event.stopPropagation();
  entryMenuPath = path;
}

async function toggleDirectory(path: string) {
  if (expandedDirectories.includes(path)) {
    expandedDirectories = expandedDirectories.filter((directory) => directory !== path);
    return;
  }
  if (loadingDirectories.includes(path)) return;
  loadingDirectories = [...loadingDirectories, path];
  try {
    await onLoadDirectory(path);
    expandedDirectories = [...expandedDirectories, path];
  } catch {
    // The parent workbench exposes the request error in the repository panel.
  } finally {
    loadingDirectories = loadingDirectories.filter((directory) => directory !== path);
  }
}

function beginCreation(kind: 'file' | 'directory', parent: string) {
  inlineCreation = { kind, parent };
  creationName = '';
  creationError = '';
  if (parent && !expandedDirectories.includes(parent)) expandedDirectories = [...expandedDirectories, parent];
}

function cancelCreation() {
  if (creating) return;
  inlineCreation = undefined;
  creationName = '';
  creationError = '';
}

function validateCreationName(name: string): string | undefined {
  if (!name) return 'Enter a name.';
  if (name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) {
    return 'Use a single file or folder name.';
  }
  return undefined;
}

async function submitCreation() {
  if (!inlineCreation || creating) return;
  const name = creationName.trim();
  const validationError = validateCreationName(name);
  if (validationError) {
    creationError = validationError;
    return;
  }

  creating = true;
  creationError = '';
  try {
    if (inlineCreation.kind === 'file') await onCreateFile(inlineCreation.parent, name);
    else await onCreateDirectory(inlineCreation.parent, name);
    inlineCreation = undefined;
    creationName = '';
  } catch (error) {
    creationError = error instanceof Error ? error.message : 'The entry could not be created.';
  } finally {
    creating = false;
  }
}

function selectFile(path: string) {
  cancelCreation();
  onSelect({ kind: 'file', path });
}

async function revealFilePath(path: string, requestId: number) {
  const parts = path.split('/').filter(Boolean);
  let directory = '';
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (requestId !== revealRequestId) return;
    directory = directory ? `${directory}/${parts[index]}` : parts[index];
    try {
      await onLoadDirectory(directory);
    } catch {
      return;
    }
    if (requestId !== revealRequestId) return;
    if (!expandedDirectories.includes(directory)) expandedDirectories = [...expandedDirectories, directory];
  }
}

$effect(() => {
  const request = rootCreationRequest;
  if (request && request.token !== handledCreationToken) {
    handledCreationToken = request.token;
    beginCreation(request.kind, '');
  }
});

$effect(() => {
  const targetPath = selected?.kind === 'file' ? selected.path : '';
  if (!targetPath) {
    revealRequestPath = '';
    return;
  }
  if (targetPath === revealRequestPath) return;
  revealRequestPath = targetPath;
  const requestId = ++revealRequestId;
  void revealFilePath(targetPath, requestId);
});
</script>

<div role="tabpanel" aria-label="Workspace files">
  {#if treeRows.length === 0 && !inlineCreation}
    <div class="repository-empty">
      <strong>No files yet</strong>
      <p>Use + or drop files into this panel.</p>
    </div>
  {:else}
    <div class="file-tree">
      {#if inlineCreation?.parent === ''}
        <RepositoryInlineEntry
          kind={inlineCreation.kind}
          bind:value={creationName}
          error={creationError}
          {creating}
          onSubmit={() => void submitCreation()}
          onCancel={cancelCreation}
        />
      {/if}
      {#each treeRows as row (row.path)}
        {@const changeKind = changeKinds.get(row.path)}
        {@const gitIgnored = isGitIgnored(row.path)}
        <div
          class="tree-row-shell"
          role="group"
          class:directory={row.kind === 'directory'}
          class:dragging={draggingPath === row.path}
          class:drop-candidate={row.kind === 'directory' && isDirectoryDropCandidate(row.path)}
          class:drop-target={dropTargetDirectory === row.path}
          class:ignored={gitIgnored}
          class:selected={selected?.kind === 'file' && selected.path === row.path}
          oncontextmenu={(event) => openEntryMenu(event, row.path)}
          ondragover={row.kind === 'directory' ? (event) => handleDirectoryDragOver(event, row.path) : undefined}
          ondragleave={row.kind === 'directory' ? (event) => handleDirectoryDragLeave(event, row.path) : undefined}
          ondrop={row.kind === 'directory' ? (event) => handleDirectoryDrop(event, row.path) : undefined}
        >
          <button
            type="button"
            class="tree-row"
            class:modified={changeKind === 'modified'}
            class:added={changeKind === 'added'}
            draggable={true}
            ondragstart={(event) => beginEntryDrag(event, row.path, row.kind)}
            ondragend={endEntryDrag}
            onclick={() => row.kind === 'directory' ? void toggleDirectory(row.path) : selectFile(row.path)}
            aria-busy={row.kind === 'directory' && loadingDirectories.includes(row.path)}
            aria-expanded={row.kind === 'directory' ? expandedDirectories.includes(row.path) : undefined}
            aria-label={`${row.kind === 'directory' ? `${expandedDirectories.includes(row.path) ? 'Collapse' : 'Expand'} ${row.path}` : `Open ${row.path}`}${gitIgnored ? ', ignored by Git' : ''}`}
          >
            <span class="tree-indent" aria-hidden="true">
              {#each Array(row.depth) as _}
                <span></span>
              {/each}
            </span>
            {#if row.kind === 'directory'}
              <span class="tree-chevron" aria-hidden="true">
                {#if expandedDirectories.includes(row.path)}
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
                {#if expandedDirectories.includes(row.path)}
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
            {#if dropTargetDirectory === row.path}
              <span class="tree-drop-label">{dropTargetOperation === 'move' ? 'Move here' : 'Copy here'}</span>
            {/if}
          </button>
          <div class="tree-actions" class:open={entryMenuPath === row.path}>
            <RepositoryEntryMenu
              path={row.path}
              kind={row.kind}
              open={entryMenuPath === row.path}
              onOpenChange={(open) => entryMenuPath = open ? row.path : ''}
              onCreateFile={() => beginCreation('file', row.path)}
              onCreateFolder={() => beginCreation('directory', row.path)}
              onInsertPath={() => onInsertPath({ path: row.path, kind: row.kind })}
              onDelete={() => onRequestDelete(row.path, row.kind)}
            />
          </div>
        </div>
        {#if inlineCreation?.parent === row.path}
          <RepositoryInlineEntry
            kind={inlineCreation.kind}
            depth={row.depth + 1}
            nested
            bind:value={creationName}
            error={creationError}
            {creating}
            onSubmit={() => void submitCreation()}
            onCancel={cancelCreation}
          />
        {/if}
      {/each}
    </div>
  {/if}
</div>

<style>
.repository-empty {
  padding: 1.5rem 1rem;
}
.repository-empty strong {
  font-size: var(--text-body);
  font-weight: var(--weight-medium);
}
.repository-empty p {
  margin: 0.35rem 0 0;
  color: var(--color-text-secondary);
  font-size: var(--text-caption);
  line-height: var(--leading-body);
}
.file-tree {
  padding: 0.35rem 0;
}
.tree-row-shell {
  display: flex;
  align-items: center;
  min-width: 0;
  min-height: 2rem;
  border-bottom: 1px solid transparent;
}
.tree-row-shell.selected {
  background: var(--color-surface-raised);
}
.tree-row-shell.selected {
  background: var(--color-surface-active);
}
.tree-row-shell.dragging {
  opacity: 0.45;
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
.tree-row-shell.drop-target .tree-row,
.tree-row-shell.drop-target .tree-icon {
  color: var(--color-accent-soft-text);
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
.tree-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: var(--text-caption);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tree-drop-label {
  flex: 0 0 auto;
  margin-left: 0.45rem;
  padding: 0.12rem 0.38rem;
  border: 1px solid color-mix(in srgb, var(--color-accent) 45%, transparent);
  border-radius: var(--radius-pill);
  background: var(--color-panel);
  color: var(--color-accent-soft-text);
  font-family: var(--font-sans);
  font-size: var(--text-micro);
  line-height: 1.2;
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
