<script lang="ts">
import CircleAlert from '@lucide/svelte/icons/circle-alert';
import RefreshCw from '@lucide/svelte/icons/refresh-cw';
import Button from '~/lib/shared/ui/Button.svelte';
import Spinner from '~/lib/shared/ui/Spinner.svelte';
import WorkspacePanelHeader from '~/lib/shared/ui/WorkspacePanelHeader.svelte';
import {
  parseWorkspaceEntryDragEntries,
  WORKSPACE_ENTRY_DRAG_TYPE,
  workspaceEntryCanMoveToDirectory,
  type WorkspaceEntryDragData,
} from '~/lib/shared/lib/workspace-entry-drag.ts';
import RepositoryAddMenu from './RepositoryAddMenu.svelte';
import RepositoryFileTree from './RepositoryFileTree.svelte';
import RepositoryGitPanel from './RepositoryGitPanel.svelte';
import type {
  RepositoryChange,
  RepositoryBranch,
  RepositorySelection,
  RepositorySnapshot,
  RepositoryTab,
  WorkspaceMoveResult,
} from '~/lib/shared/contracts/repository';
import {
  dataTransferHasUploadFiles,
  uploadSelectionFromDataTransfer,
  uploadSelectionFromFiles,
  type WorkspaceUploadSelection,
} from '../api/upload';
import type { RepositoryUploadNoticeKind } from '../model/workspace-state.svelte';

let {
  projectName,
  projectPath,
  snapshot,
  loading,
  errorMessage,
  selected,
  activeTab = 'files',
  open,
  onRefresh,
  onLoadDirectory,
  onCreateFile,
  onCreateDirectory,
  onRequestDelete,
  onRequestDiscardChange,
  onRequestDeleteBranch,
  onLoadMoreCommits,
  loadingMoreCommits = false,
  onMoveEntry,
  onInsertPath,
  onRenameEntry,
  onCopyEntries,
  onCutEntries,
  onPasteEntries,
  canPaste = false,
  cutPaths = [],
  uploading = false,
  moving = false,
  uploadNoticeKind = '',
  uploadNotice = '',
  uploadRevealRequest,
  onUploadSelection,
  onUploadError,
  onClose,
  onSelect,
  onTabChange = () => undefined,
}: {
  projectName: string;
  projectPath: string;
  snapshot?: RepositorySnapshot;
  loading: boolean;
  errorMessage: string;
  selected?: RepositorySelection;
  activeTab?: RepositoryTab;
  open: boolean;
  onRefresh: () => void;
  onLoadDirectory: (path: string) => Promise<void>;
  onCreateFile: (directory: string, name: string) => Promise<void>;
  onCreateDirectory: (directory: string, name: string) => Promise<void>;
  onRequestDelete: (entries: WorkspaceEntryDragData[]) => void;
  onRequestDiscardChange: (change: RepositoryChange) => void;
  onRequestDeleteBranch: (branch: RepositoryBranch) => void;
  onLoadMoreCommits: () => Promise<void>;
  loadingMoreCommits?: boolean;
  onMoveEntry: (entry: WorkspaceEntryDragData, directory: string) => Promise<WorkspaceMoveResult | undefined>;
  onInsertPath: (entry: WorkspaceEntryDragData) => void;
  onRenameEntry: (entry: WorkspaceEntryDragData, name: string) => Promise<WorkspaceMoveResult>;
  onCopyEntries: (entries: WorkspaceEntryDragData[]) => void;
  onCutEntries: (entries: WorkspaceEntryDragData[]) => void;
  onPasteEntries: (directory: string) => Promise<WorkspaceMoveResult[]>;
  canPaste?: boolean;
  cutPaths?: string[];
  uploading?: boolean;
  moving?: boolean;
  uploadNoticeKind?: RepositoryUploadNoticeKind;
  uploadNotice?: string;
  uploadRevealRequest?: { path: string; token: number };
  onUploadSelection: (selection: WorkspaceUploadSelection, directory: string) => Promise<void>;
  onUploadError: (message: string) => void;
  onClose: () => void;
  onSelect: (selection: RepositorySelection) => void;
  onTabChange?: (tab: RepositoryTab) => void;
} = $props();

const visibleTab = $derived(snapshot?.isGitRepository === false ? 'files' : activeTab);
let fileInput: HTMLInputElement;
let folderInput: HTMLInputElement;
let rootCreationRequest = $state<{ kind: 'file' | 'directory'; parent: string; token: number }>();
let rootCreationToken = 0;
let rootDropKind = $state<'' | 'copy' | 'move'>('');
let dropOperation = $state<'' | 'copy' | 'move'>('');
let readingDrop = $state(false);

function beginRootCreation(kind: 'file' | 'directory') {
  onTabChange('files');
  rootCreationRequest = { kind, parent: '', token: ++rootCreationToken };
}

async function uploadFilesFromInput(input: HTMLInputElement) {
  try {
    const selection = uploadSelectionFromFiles(input.files ?? []);
    onTabChange('files');
    await onUploadSelection(selection, '');
  } catch (error) {
    onUploadError(error instanceof Error ? error.message : 'The selected files could not be added.');
  } finally {
    input.value = '';
  }
}

function handleRootDragOver(event: DragEvent) {
  const dataTransfer = event.dataTransfer;
  if (!dataTransfer) return;
  const row = event.target instanceof Element ? event.target.closest('.tree-row-shell') : null;
  const nestedRow = Boolean(row && !row.classList.contains('root'));
  if (dataTransferHasUploadFiles(dataTransfer)) {
    event.preventDefault();
    dropOperation = 'copy';
    if (nestedRow) {
      rootDropKind = '';
      return;
    }
    dataTransfer.dropEffect = 'copy';
    rootDropKind = 'copy';
    return;
  }
  if (!Array.from(dataTransfer.types).includes(WORKSPACE_ENTRY_DRAG_TYPE)) return;
  dropOperation = 'move';
  if (nestedRow) {
    rootDropKind = '';
    return;
  }
  const entries = parseWorkspaceEntryDragEntries(dataTransfer.getData(WORKSPACE_ENTRY_DRAG_TYPE));
  if (entries?.some((entry) => !workspaceEntryCanMoveToDirectory(entry, ''))) return;
  event.preventDefault();
  dataTransfer.dropEffect = 'move';
  rootDropKind = 'move';
}

function handleRootDragLeave(event: DragEvent) {
  const current = event.currentTarget;
  const related = event.relatedTarget;
  if (current instanceof Node && related instanceof Node && current.contains(related)) return;
  rootDropKind = '';
  dropOperation = '';
}

async function uploadDrop(dataTransfer: DataTransfer, directory: string) {
  rootDropKind = '';
  dropOperation = '';
  readingDrop = true;
  try {
    const selection = await uploadSelectionFromDataTransfer(dataTransfer);
    onTabChange('files');
    await onUploadSelection(selection, directory);
  } catch (error) {
    onUploadError(error instanceof Error ? error.message : 'The dropped files could not be added.');
  } finally {
    readingDrop = false;
  }
}

function handleRootDrop(event: DragEvent) {
  const dataTransfer = event.dataTransfer;
  if (!dataTransfer) return;
  const row = event.target instanceof Element ? event.target.closest('.tree-row-shell') : null;
  const nestedRow = Boolean(row && !row.classList.contains('root'));
  rootDropKind = '';
  dropOperation = '';
  if (dataTransferHasUploadFiles(dataTransfer)) {
    event.preventDefault();
    if (nestedRow) return;
    void uploadDrop(dataTransfer, '');
    return;
  }
  if (nestedRow) return;
  if (!Array.from(dataTransfer.types).includes(WORKSPACE_ENTRY_DRAG_TYPE)) return;
  const entries = parseWorkspaceEntryDragEntries(dataTransfer.getData(WORKSPACE_ENTRY_DRAG_TYPE));
  if (!entries?.length || entries.some((entry) => !workspaceEntryCanMoveToDirectory(entry, ''))) return;
  event.preventDefault();
  onTabChange('files');
  void moveEntriesToRoot(entries);
}

async function moveEntriesToRoot(entries: WorkspaceEntryDragData[]) {
  for (const entry of entries) await onMoveEntry(entry, '');
}

function endDragWorkspace() {
  rootDropKind = '';
  dropOperation = '';
}
</script>

<aside
  class="repository-panel"
  class:open
  class:root-drop-active={Boolean(rootDropKind)}
  aria-label={`${snapshot?.isGitRepository === false ? 'Files' : 'Repository'} for ${projectName}`}
  aria-hidden={!open}
  inert={!open}
  aria-busy={uploading || readingDrop || moving}
  ondragenter={handleRootDragOver}
  ondragover={handleRootDragOver}
  ondragleave={handleRootDragLeave}
  ondrop={handleRootDrop}
  ondragend={endDragWorkspace}
>
  <WorkspacePanelHeader
    title="Workspace"
    subtitle={projectPath}
    subtitleMonospace
    close={onClose}
    closeLabel="Close workspace panel"
  >
    {#snippet actions()}
      <Button
        class={`repository-refresh${loading ? ' spinning' : ''}`}
        variant="icon"
        onclick={onRefresh}
        disabled={loading}
        ariaLabel="Refresh workspace and Git"
        title="Refresh workspace and Git"
      >
        <RefreshCw size={17} strokeWidth={1.8} aria-hidden="true" />
      </Button>
    {/snippet}
  </WorkspacePanelHeader>
  {#if snapshot?.isGitRepository !== false}
    <div class="repository-tabs" role="tablist" aria-label="Repository view">
      <button
        type="button"
        role="tab"
        class:active={visibleTab === 'files'}
        aria-selected={visibleTab === 'files'}
        onclick={() => onTabChange('files')}
      >
        Explorer
      </button>
      <button
        type="button"
        role="tab"
        class:active={visibleTab === 'changes'}
        aria-selected={visibleTab === 'changes'}
        onclick={() => onTabChange('changes')}
      >
        Git
      </button>
    </div>
  {/if}
  <input
    class="repository-file-input"
    bind:this={fileInput}
    type="file"
    multiple
    onchange={(event) => void uploadFilesFromInput(event.currentTarget)}
  >
  <input
    class="repository-file-input"
    bind:this={folderInput}
    type="file"
    multiple
    webkitdirectory
    onchange={(event) => void uploadFilesFromInput(event.currentTarget)}
  >

  {#if errorMessage}
    <p class="repository-warning" role="status">{errorMessage}</p>
  {/if}
  {#if uploadNoticeKind === 'error' && uploadNotice}
    <p class="repository-upload-notice" role="alert">
      <CircleAlert size={15} strokeWidth={1.8} aria-hidden="true" />
      <span>{uploadNotice}</span>
    </p>
  {/if}

  <div class="repository-content" class:repository-content-git={visibleTab === 'changes' && Boolean(snapshot?.git)}>
    {#if loading && !snapshot}
      <div class="repository-state" aria-live="polite">
        <Spinner size="small" />
        Reading repository…
      </div>
    {:else if !snapshot}
      <div class="repository-state">Repository information is unavailable.</div>
    {:else if visibleTab === 'changes' && snapshot.git}
      <RepositoryGitPanel
        {snapshot}
        git={snapshot.git}
        {selected}
        {onSelect}
        {onRequestDiscardChange}
        {onRequestDeleteBranch}
        {onLoadMoreCommits}
        {loadingMoreCommits}
        onOpenFiles={() => onTabChange('files')}
      />
    {:else}
      <RepositoryFileTree
        {snapshot}
        {projectName}
        {projectPath}
        {selected}
        {onLoadDirectory}
        {onCreateFile}
        {onCreateDirectory}
        {onRequestDelete}
        {rootCreationRequest}
        revealRequest={uploadRevealRequest}
        onDropFiles={(directory, dataTransfer) => uploadDrop(dataTransfer, directory)}
        {onMoveEntry}
        {onInsertPath}
        {onRenameEntry}
        {onCopyEntries}
        {onCutEntries}
        {onPasteEntries}
        {canPaste}
        {cutPaths}
        {dropOperation}
        {onSelect}
      >
        {#snippet rootActions()}
          <RepositoryAddMenu
            disabled={uploading || readingDrop || moving}
            rootPath={projectPath}
            {canPaste}
            onCreateFile={() => beginRootCreation('file')}
            onCreateFolder={() => beginRootCreation('directory')}
            onUploadFiles={() => fileInput?.click()}
            onUploadFolder={() => folderInput?.click()}
            onPaste={() => void onPasteEntries('')}
          />
        {/snippet}
      </RepositoryFileTree>
    {/if}
  </div>
  {#if snapshot?.truncated}
    <p class="repository-limit">Some folders contain more entries than shown.</p>
  {/if}
</aside>

<style>
.repository-panel {
  position: absolute;
  z-index: 10;
  top: 0;
  right: 0;
  display: flex;
  flex-direction: column;
  width: var(--workspace-panel-width, min(22rem, calc(100% - 3rem)));
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  transform: translateX(100%);
  border-left: 1px solid var(--color-border);
  background: var(--color-panel);
  box-shadow: var(--shadow-repository-panel);
  color: var(--color-text);
  pointer-events: none;
}
.repository-panel.open {
  transform: translateX(0);
  pointer-events: auto;
}
.repository-file-input {
  display: none;
}
.repository-upload-notice {
  position: absolute;
  z-index: 30;
  right: var(--space-3);
  bottom: var(--space-3);
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: start;
  gap: 0.45rem;
  margin: 0;
  width: min(18rem, calc(100% - var(--space-6)));
  padding: 0.55rem 0.8rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-control);
  background: var(--color-surface-raised);
  box-shadow: var(--shadow-popover);
  color: var(--color-text-secondary);
  font-size: var(--text-caption);
  line-height: var(--leading-ui);
}
.repository-upload-notice {
  background: var(--color-danger-surface);
  color: var(--color-danger-text);
}
.repository-upload-notice span {
  min-width: 0;
  overflow-wrap: anywhere;
}
.repository-panel.root-drop-active .repository-content {
  background: color-mix(in srgb, var(--color-accent) 8%, transparent);
  box-shadow:
    inset 0 0 0 1px var(--color-accent),
    inset 3px 0 0 var(--color-accent);
}
:global(.repository-refresh.spinning svg) {
  animation: spin 0.8s linear infinite;
}
.repository-tabs {
  display: grid;
  flex: 0 0 auto;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  margin: 0 var(--space-3);
  border-bottom: 1px solid var(--color-border);
}
.repository-tabs button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  min-height: 2.7rem;
  padding: 0 0.5rem;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--color-text-tertiary);
  font-size: var(--text-label);
  font-weight: var(--weight-medium);
  cursor: pointer;
}
.repository-tabs button:focus-visible {
  color: var(--color-text);
  outline: none;
}
@media (hover: hover) {
  .repository-tabs button:hover {
    color: var(--color-text);
  }
}
.repository-tabs button.active {
  border-bottom-color: var(--color-accent);
  color: var(--color-text);
}
.repository-warning {
  flex: 0 0 auto;
  margin: 0;
  padding: 0.6rem 0.85rem;
  border-bottom: 1px solid var(--color-danger-border);
  background: var(--color-danger-surface);
  color: var(--color-danger-text);
  font-size: var(--text-caption);
  line-height: var(--leading-ui);
}
.repository-content {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  transition:
    background-color 120ms ease,
    box-shadow 120ms ease;
}
.repository-content.repository-content-git {
  overflow: hidden;
}
.repository-state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.55rem;
  min-height: 8rem;
  padding: 1rem;
  color: var(--color-text-secondary);
  font-size: var(--text-label);
  text-align: center;
}
.repository-limit {
  flex: 0 0 auto;
  margin: 0;
  padding: 0.55rem 0.8rem;
  border-top: 1px solid var(--color-border);
  color: var(--color-text-tertiary);
  font-size: var(--text-micro);
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (width < 80rem) {
  .repository-panel {
    position: fixed;
    z-index: 40;
    width: var(--workspace-panel-width, min(23rem, calc(100% - 2.75rem)));
    height: 100dvh;
    padding-top: env(safe-area-inset-top);
    padding-bottom: env(safe-area-inset-bottom);
    transition: transform 180ms ease;
  }
}

@media (min-width: 80rem) {
  .repository-panel {
    position: relative;
    z-index: 1;
    top: auto;
    right: auto;
    grid-column: 2;
    grid-row: 1;
    width: 100%;
    height: 100%;
    transform: none;
    box-shadow: none;
    visibility: hidden;
  }
  .repository-panel.open {
    visibility: visible;
  }
}

@media (prefers-reduced-motion: reduce) {
  :global(.repository-refresh.spinning svg) {
    animation-duration: 1.6s;
  }
  .repository-panel {
    transition: none;
  }
}
</style>
