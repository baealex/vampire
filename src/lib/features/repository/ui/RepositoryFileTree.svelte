<script lang="ts">
import { onDestroy, tick } from 'svelte';
import type { Snippet } from 'svelte';
import ChevronDown from '@lucide/svelte/icons/chevron-down';
import ChevronRight from '@lucide/svelte/icons/chevron-right';
import FileText from '@lucide/svelte/icons/file-text';
import Folder from '@lucide/svelte/icons/folder';
import FolderOpen from '@lucide/svelte/icons/folder-open';
import ImageIcon from '@lucide/svelte/icons/image';
import {
  parseWorkspaceEntryDragEntries,
  WORKSPACE_ENTRY_DRAG_TYPE,
  workspaceEntryCanMoveToDirectory,
  workspaceEntryDragText,
  workspaceEntryParent,
  type WorkspaceEntryDragData,
} from '~/lib/shared/lib/workspace-entry-drag.ts';
import RepositoryEntryMenu from './RepositoryEntryMenu.svelte';
import RepositoryDirectoryAddMenu from './RepositoryDirectoryAddMenu.svelte';
import RepositoryInlineEntry from './RepositoryInlineEntry.svelte';
import RepositoryInlineRename from './RepositoryInlineRename.svelte';
import RepositoryTreeViewMenu from './RepositoryTreeViewMenu.svelte';
import { dataTransferHasUploadFiles } from '../api/upload';
import { buildChangeKindMap, buildVisibleFileTree, isPreviewableImage } from '../model/view';
import type { RepositorySelection, RepositorySnapshot, WorkspaceMoveResult } from '~/lib/shared/contracts/repository';

let {
  snapshot,
  projectName,
  projectPath,
  selected,
  onLoadDirectory,
  onCreateFile,
  onCreateDirectory,
  onRequestDelete,
  rootCreationRequest,
  revealRequest,
  onDropFiles,
  onMoveEntry,
  onInsertPath,
  onRenameEntry,
  onCopyEntries,
  onCutEntries,
  onPasteEntries,
  onSelectionChange = () => undefined,
  canPaste = false,
  cutPaths = [],
  dropOperation = '',
  onSelect,
  rootActions,
}: {
  snapshot: RepositorySnapshot;
  projectName: string;
  projectPath: string;
  selected?: RepositorySelection;
  onLoadDirectory: (path: string) => Promise<void>;
  onCreateFile: (directory: string, name: string) => Promise<void>;
  onCreateDirectory: (directory: string, name: string) => Promise<void>;
  onRequestDelete: (entries: WorkspaceEntryDragData[]) => void;
  rootCreationRequest?: { kind: 'file' | 'directory'; parent: string; token: number };
  revealRequest?: { path: string; token: number };
  onDropFiles: (directory: string, dataTransfer: DataTransfer) => Promise<void>;
  onMoveEntry: (entry: WorkspaceEntryDragData, directory: string) => Promise<WorkspaceMoveResult | undefined>;
  onInsertPath: (entry: WorkspaceEntryDragData) => void;
  onRenameEntry: (entry: WorkspaceEntryDragData, name: string) => Promise<WorkspaceMoveResult>;
  onCopyEntries: (entries: WorkspaceEntryDragData[]) => void;
  onCutEntries: (entries: WorkspaceEntryDragData[]) => void;
  onPasteEntries: (directory: string) => Promise<WorkspaceMoveResult[]>;
  onSelectionChange?: (entries: WorkspaceEntryDragData[]) => void;
  canPaste?: boolean;
  cutPaths?: string[];
  dropOperation?: '' | 'copy' | 'move';
  onSelect: (selection: RepositorySelection) => void;
  rootActions?: Snippet;
} = $props();

let rootExpanded = $state(true);
let expandedDirectories = $state<string[]>([]);
let inlineCreation = $state<{ kind: 'file' | 'directory'; parent: string }>();
let creationName = $state('');
let creationError = $state('');
let creating = $state(false);
let loadingDirectories = $state<string[]>([]);
let draggingPath = $state('');
let draggingEntry = $state<WorkspaceEntryDragData>();
let draggingEntries = $state<WorkspaceEntryDragData[]>([]);
let dropTargetPath = $state('');
let entryMenuPath = $state('');
let selectedEntries = $state<WorkspaceEntryDragData[]>([]);
let selectionAnchor = $state('');
let renameTarget = $state<WorkspaceEntryDragData>();
let renameName = $state('');
let renameError = $state('');
let renaming = $state(false);
let rootTreeMenuOpen = $state(false);
let treeRows = $derived(buildVisibleFileTree(snapshot.files, expandedDirectories, snapshot.directories));
let changeKinds = $derived(buildChangeKindMap(snapshot.changes));
let ignoredPaths = $derived(new Set(snapshot.ignored));
let revealRequestPath = '';
let revealRequestId = 0;
let handledCreationToken = 0;
let handledRevealToken = 0;
let treeElement: HTMLDivElement | undefined;
let dragExpandPath = '';
let dragExpandTimer: ReturnType<typeof setTimeout> | undefined;

const DRAG_EXPAND_DELAY_MS = 650;

function cancelDragExpand(path?: string) {
  if (path && dragExpandPath !== path) return;
  if (dragExpandTimer) clearTimeout(dragExpandTimer);
  dragExpandTimer = undefined;
  dragExpandPath = '';
}

function scheduleDragExpand(entry: WorkspaceEntryDragData) {
  if (entry.kind !== 'directory' || expandedDirectories.includes(entry.path)) {
    cancelDragExpand();
    return;
  }
  if (dragExpandPath === entry.path && dragExpandTimer) return;
  cancelDragExpand();
  dragExpandPath = entry.path;
  dragExpandTimer = setTimeout(() => {
    dragExpandTimer = undefined;
    dragExpandPath = '';
    if (dropTargetPath !== entry.path || expandedDirectories.includes(entry.path)) return;
    void toggleDirectory(entry.path);
  }, DRAG_EXPAND_DELAY_MS);
}

function beginEntryDrag(event: DragEvent, path: string, kind: 'file' | 'directory') {
  if (!event.dataTransfer) return;
  const entry = { path, kind };
  const entries = selectedEntriesFor(entry);
  event.dataTransfer.effectAllowed = 'copyMove';
  event.dataTransfer.setData(WORKSPACE_ENTRY_DRAG_TYPE, JSON.stringify({ entries }));
  event.dataTransfer.setData('text/plain', entries.map(workspaceEntryDragText).join(' '));
  draggingPath = path;
  draggingEntry = entry;
  draggingEntries = entries;
}

function endEntryDrag() {
  cancelDragExpand();
  draggingPath = '';
  draggingEntry = undefined;
  draggingEntries = [];
  dropTargetPath = '';
}

function dropDirectoryForEntry(entry: WorkspaceEntryDragData): string {
  return entry.kind === 'directory' ? entry.path : workspaceEntryParent(entry.path);
}

function handleEntryDragOver(event: DragEvent, entry: WorkspaceEntryDragData) {
  const dataTransfer = event.dataTransfer;
  if (!dataTransfer) return;
  const directory = dropDirectoryForEntry(entry);
  if (dataTransferHasUploadFiles(dataTransfer)) {
    event.preventDefault();
    dataTransfer.dropEffect = 'copy';
    dropTargetPath = entry.path;
    scheduleDragExpand(entry);
    return;
  }
  if (!Array.from(dataTransfer.types).includes(WORKSPACE_ENTRY_DRAG_TYPE)) return;
  const entries =
    draggingEntries.length > 0
      ? draggingEntries
      : parseWorkspaceEntryDragEntries(dataTransfer.getData(WORKSPACE_ENTRY_DRAG_TYPE));
  if (!entries?.length || entries.some((candidate) => !workspaceEntryCanMoveToDirectory(candidate, directory))) return;
  event.preventDefault();
  dataTransfer.dropEffect = 'move';
  dropTargetPath = entry.path;
  scheduleDragExpand(entry);
}

function handleEntryDragLeave(event: DragEvent, path: string) {
  if (dropTargetPath !== path) return;
  event.stopPropagation();
  const current = event.currentTarget;
  const related = event.relatedTarget;
  if (current instanceof Node && related instanceof Node && current.contains(related)) return;
  cancelDragExpand(path);
  dropTargetPath = '';
}

function handleEntryDrop(event: DragEvent, entry: WorkspaceEntryDragData) {
  const dataTransfer = event.dataTransfer;
  if (!dataTransfer) return;
  cancelDragExpand();
  const directory = dropDirectoryForEntry(entry);
  if (dataTransferHasUploadFiles(dataTransfer)) {
    event.preventDefault();
    event.stopPropagation();
    dropTargetPath = '';
    void uploadFilesIntoDirectory(directory, dataTransfer);
    return;
  }
  if (!Array.from(dataTransfer.types).includes(WORKSPACE_ENTRY_DRAG_TYPE)) return;
  const entries =
    draggingEntries.length > 0
      ? draggingEntries
      : parseWorkspaceEntryDragEntries(dataTransfer.getData(WORKSPACE_ENTRY_DRAG_TYPE));
  if (!entries?.length || entries.some((candidate) => !workspaceEntryCanMoveToDirectory(candidate, directory))) return;
  event.preventDefault();
  event.stopPropagation();
  dropTargetPath = '';
  void moveEntriesToDirectory(entries, directory);
}

async function uploadFilesIntoDirectory(directory: string, dataTransfer: DataTransfer) {
  await onDropFiles(directory, dataTransfer);
  if (!directory) return;
  try {
    await onLoadDirectory(directory);
    if (!expandedDirectories.includes(directory)) expandedDirectories = [...expandedDirectories, directory];
  } catch {
    // The upload succeeded; the parent panel displays any folder refresh error.
  }
}

function isDirectoryDropCandidate(path: string): boolean {
  if (!dropOperation) return false;
  if (dropOperation === 'copy' || !draggingEntry) return true;
  return draggingEntries.length > 0
    ? draggingEntries.every((entry) => workspaceEntryCanMoveToDirectory(entry, path))
    : workspaceEntryCanMoveToDirectory(draggingEntry, path);
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

async function moveEntriesToDirectory(entries: WorkspaceEntryDragData[], path: string) {
  const results: WorkspaceMoveResult[] = [];
  for (const entry of entries) {
    const result = await onMoveEntry(entry, path);
    if (result) {
      results.push(result);
      rebaseExpandedDirectories(result);
    }
  }
  if (results.length === 0) return;
  setSelectedEntries(results.map((result) => ({ path: result.path, kind: result.kind })));
  try {
    await onLoadDirectory(path);
    if (!expandedDirectories.includes(path)) expandedDirectories = [...expandedDirectories, path];
  } catch {
    // The moves succeeded; the parent panel displays any refresh error.
  }
}

function entryIsSelected(path: string): boolean {
  return selectedEntries.some((entry) => entry.path === path);
}

function setSelectedEntries(entries: WorkspaceEntryDragData[]) {
  selectedEntries = entries;
  onSelectionChange(entries);
}

function selectedEntriesFor(entry: WorkspaceEntryDragData): WorkspaceEntryDragData[] {
  return entryIsSelected(entry.path) ? selectedEntries : [entry];
}

function openEntryMenu(event: MouseEvent, entry: WorkspaceEntryDragData) {
  event.preventDefault();
  event.stopPropagation();
  if (!entryIsSelected(entry.path)) setSelectedEntries([entry]);
  selectionAnchor = entry.path;
  entryMenuPath = entry.path;
}

function selectTreeRow(event: MouseEvent, entry: WorkspaceEntryDragData) {
  const modifier = event.metaKey || event.ctrlKey;
  if (event.shiftKey && selectionAnchor) {
    const anchorIndex = treeRows.findIndex((row) => row.path === selectionAnchor);
    const targetIndex = treeRows.findIndex((row) => row.path === entry.path);
    if (anchorIndex >= 0 && targetIndex >= 0) {
      const [start, end] = anchorIndex < targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
      setSelectedEntries(treeRows.slice(start, end + 1).map((row) => ({ path: row.path, kind: row.kind })));
    }
  } else if (modifier) {
    setSelectedEntries(
      entryIsSelected(entry.path)
        ? selectedEntries.filter((candidate) => candidate.path !== entry.path)
        : [...selectedEntries, entry]
    );
    selectionAnchor = entry.path;
  } else {
    setSelectedEntries([entry]);
    selectionAnchor = entry.path;
  }
  if (modifier || event.shiftKey) return;
  if (entry.kind === 'directory') void toggleDirectory(entry.path);
  else selectFile(entry.path);
}

function focusRelativeRow(path: string, offset: -1 | 1) {
  const index = treeRows.findIndex((row) => row.path === path);
  const next = treeRows[index + offset];
  if (!next) return;
  [...document.querySelectorAll<HTMLButtonElement>('[data-tree-path]')]
    .find((element) => element.dataset.treePath === next.path)
    ?.focus();
}

function focusTreePath(path: string) {
  [...document.querySelectorAll<HTMLButtonElement>('[data-tree-path]')]
    .find((element) => element.dataset.treePath === path)
    ?.focus();
}

function handleTreeKeydown(event: KeyboardEvent, entry: WorkspaceEntryDragData) {
  const modifier = event.metaKey || event.ctrlKey;
  const key = event.key.toLowerCase();
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    focusRelativeRow(entry.path, event.key === 'ArrowDown' ? 1 : -1);
  } else if (event.key === 'ArrowRight' && entry.kind === 'directory') {
    event.preventDefault();
    if (!expandedDirectories.includes(entry.path)) void toggleDirectory(entry.path);
    else {
      const child = treeRows.find((row) => workspaceEntryParent(row.path) === entry.path);
      if (child) focusTreePath(child.path);
    }
  } else if (event.key === 'ArrowLeft') {
    event.preventDefault();
    if (entry.kind === 'directory' && expandedDirectories.includes(entry.path)) void toggleDirectory(entry.path);
    else {
      const parent = workspaceEntryParent(entry.path);
      if (parent) focusTreePath(parent);
    }
  } else if (event.key === 'F2') {
    event.preventDefault();
    beginRename(entry);
  } else if (modifier && key === 'c') {
    event.preventDefault();
    onCopyEntries(selectedEntriesFor(entry));
  } else if (modifier && key === 'x') {
    event.preventDefault();
    onCutEntries(selectedEntriesFor(entry));
  } else if (modifier && key === 'v' && canPaste) {
    event.preventDefault();
    void pasteIntoDirectory(entry.kind === 'directory' ? entry.path : workspaceEntryParent(entry.path));
  } else if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault();
    onRequestDelete(selectedEntriesFor(entry));
  }
}

function beginRename(entry: WorkspaceEntryDragData) {
  renameTarget = entry;
  renameName = entry.path.split('/').pop() || entry.path;
  renameError = '';
}

function cancelRename() {
  if (renaming) return;
  renameTarget = undefined;
  renameName = '';
  renameError = '';
}

async function submitRename() {
  if (!renameTarget || renaming) return;
  const name = renameName.trim();
  const validationError = validateCreationName(name);
  if (validationError) {
    renameError = validationError;
    return;
  }
  const currentName = renameTarget.path.split('/').pop() || renameTarget.path;
  if (name === currentName) {
    cancelRename();
    return;
  }
  renaming = true;
  renameError = '';
  try {
    const result = await onRenameEntry(renameTarget, name);
    rebaseExpandedDirectories(result);
    setSelectedEntries(
      selectedEntries.map((entry) => ({
        ...entry,
        path:
          entry.path === result.fromPath
            ? result.path
            : result.kind === 'directory' && entry.path.startsWith(`${result.fromPath}/`)
              ? `${result.path}${entry.path.slice(result.fromPath.length)}`
              : entry.path,
      }))
    );
    renameTarget = undefined;
    renameName = '';
  } catch (error) {
    renameError = error instanceof Error ? error.message : 'The entry could not be renamed.';
  } finally {
    renaming = false;
  }
}

async function pasteIntoDirectory(path: string) {
  const results = await onPasteEntries(path);
  if (results.length === 0) return;
  setSelectedEntries(results.map((result) => ({ path: result.path, kind: result.kind })));
  await onLoadDirectory(path);
  if (!expandedDirectories.includes(path)) expandedDirectories = [...expandedDirectories, path];
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

function collapseAllDirectories() {
  cancelDragExpand();
  expandedDirectories = [];
}

async function beginCreation(kind: 'file' | 'directory', parent: string) {
  inlineCreation = { kind, parent };
  creationName = '';
  creationError = '';
  if (!parent) return;
  if (!expandedDirectories.includes(parent)) expandedDirectories = [...expandedDirectories, parent];
  if (loadingDirectories.includes(parent)) return;
  loadingDirectories = [...loadingDirectories, parent];
  try {
    await onLoadDirectory(parent);
  } catch {
    // Creation remains available; the parent panel exposes the folder read error.
  } finally {
    loadingDirectories = loadingDirectories.filter((directory) => directory !== parent);
  }
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
  await tick();
  if (requestId !== revealRequestId) return;
  [...(treeElement?.querySelectorAll<HTMLElement>('[data-tree-path]') ?? [])]
    .find((element) => element.dataset.treePath === path)
    ?.scrollIntoView({ block: 'nearest' });
}

$effect(() => {
  const request = revealRequest;
  if (!request || request.token === handledRevealToken) return;
  handledRevealToken = request.token;
  rootExpanded = true;
  const requestId = ++revealRequestId;
  void revealFilePath(request.path, requestId);
});

$effect(() => {
  const request = rootCreationRequest;
  if (request && request.token !== handledCreationToken) {
    handledCreationToken = request.token;
    rootExpanded = true;
    void beginCreation(request.kind, request.parent);
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

onDestroy(cancelDragExpand);
</script>

<div bind:this={treeElement} class="repository-file-tree" role="tabpanel" aria-label="Workspace files">
  <div class="tree-row-shell root" role="group">
    <button
      type="button"
      class="tree-row"
      aria-expanded={rootExpanded}
      aria-label={`${rootExpanded ? 'Collapse' : 'Expand'} ${projectName} workspace root`}
      onclick={() => (rootExpanded = !rootExpanded)}
    >
      <span class="tree-chevron" aria-hidden="true">
        {#if rootExpanded}
          <ChevronDown size={14} strokeWidth={1.8} />
        {:else}
          <ChevronRight size={14} strokeWidth={1.8} />
        {/if}
      </span>
      <span class="tree-icon" aria-hidden="true">
        {#if rootExpanded}
          <FolderOpen size={15} strokeWidth={1.7} />
        {:else}
          <Folder size={15} strokeWidth={1.7} />
        {/if}
      </span>
      <span class="tree-name" title={projectPath}>{projectName}</span>
    </button>
    <div class="tree-actions" class:open={rootTreeMenuOpen}>
      {#if rootActions}
        {@render rootActions()}
      {/if}
      <RepositoryTreeViewMenu
        canCollapse={expandedDirectories.length > 0}
        onCollapseAll={collapseAllDirectories}
        onOpenChange={(open) => (rootTreeMenuOpen = open)}
      />
    </div>
  </div>
  {#if rootExpanded}
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
            depth={1}
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
          {@const rowEntry = { path: row.path, kind: row.kind } as WorkspaceEntryDragData}
          {#if renameTarget?.path === row.path}
            <RepositoryInlineRename
              kind={row.kind}
              depth={row.depth + 1}
              bind:value={renameName}
              error={renameError}
              {renaming}
              onSubmit={() => void submitRename()}
              onCancel={cancelRename}
            />
          {:else}
            <div
              class="tree-row-shell"
              role="group"
              class:directory={row.kind === 'directory'}
              class:dragging={draggingPath === row.path}
              class:drop-candidate={row.kind === 'directory' && isDirectoryDropCandidate(row.path)}
              class:drop-target={dropTargetPath === row.path}
              class:ignored={gitIgnored}
              class:cut={cutPaths.includes(row.path)}
              class:selected={entryIsSelected(row.path) || (selected?.kind === 'file' && selected.path === row.path)}
              oncontextmenu={(event) => openEntryMenu(event, rowEntry)}
              data-tree-path={row.path}
              data-tree-kind={row.kind}
              ondragover={(event) => handleEntryDragOver(event, rowEntry)}
              ondragleave={(event) => handleEntryDragLeave(event, row.path)}
              ondrop={(event) => handleEntryDrop(event, rowEntry)}
            >
              <button
                type="button"
                class="tree-row"
                class:modified={changeKind === 'modified'}
                class:added={changeKind === 'added'}
                draggable={true}
                data-tree-path={row.path}
                ondragstart={(event) => beginEntryDrag(event, row.path, row.kind)}
                ondragend={endEntryDrag}
                onclick={(event) => selectTreeRow(event, rowEntry)}
                onkeydown={(event) => handleTreeKeydown(event, rowEntry)}
                aria-busy={row.kind === 'directory' && loadingDirectories.includes(row.path)}
                aria-expanded={row.kind === 'directory' ? expandedDirectories.includes(row.path) : undefined}
                aria-label={`${row.kind === 'directory' ? `${expandedDirectories.includes(row.path) ? 'Collapse' : 'Expand'} ${row.path}` : `Open ${row.path}`}${gitIgnored ? ', ignored by Git' : ''}`}
              >
                <span class="tree-indent" aria-hidden="true">
                  {#each Array(row.depth + 1) as _}
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
              </button>
              <div class="tree-actions" class:open={entryMenuPath === row.path}>
                {#if row.kind === 'directory'}
                  <RepositoryDirectoryAddMenu
                    path={row.path}
                    onCreateFile={() => void beginCreation('file', row.path)}
                    onCreateFolder={() => void beginCreation('directory', row.path)}
                  />
                {/if}
                <RepositoryEntryMenu
                  path={row.path}
                  kind={row.kind}
                  open={entryMenuPath === row.path}
                  onOpenChange={(open) => entryMenuPath = open ? row.path : ''}
                  onCreateFile={() => void beginCreation('file', row.path)}
                  onCreateFolder={() => void beginCreation('directory', row.path)}
                  onInsertPath={() => onInsertPath({ path: row.path, kind: row.kind })}
                  selectedCount={selectedEntriesFor(rowEntry).length}
                  {canPaste}
                  onRename={() => beginRename(rowEntry)}
                  onCopy={() => onCopyEntries(selectedEntriesFor(rowEntry))}
                  onCut={() => onCutEntries(selectedEntriesFor(rowEntry))}
                  onPaste={() => void pasteIntoDirectory(row.path)}
                  onDelete={() => onRequestDelete(selectedEntriesFor(rowEntry))}
                />
              </div>
            </div>
          {/if}
          {#if inlineCreation?.parent === row.path}
            <RepositoryInlineEntry
              kind={inlineCreation.kind}
              depth={row.depth + 2}
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
  {/if}
</div>

<style>
.repository-file-tree {
  min-height: 100%;
}
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
  padding: 0;
}
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
.tree-row-shell.root .tree-actions {
  opacity: 1;
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
  .tree-row-shell.root .tree-actions {
    opacity: 0;
  }
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
