<script lang="ts">
import { onMount, untrack } from 'svelte';
import Terminal from './Terminal.svelte';
import type { ManagedWorkspace, MobilePanel, WorkspaceTerminal } from '~/lib/shared/contracts/workspace';
import { workspaceName } from '~/lib/features/workspace/model/workspace-view';
import type { StatusPluginSnapshot } from '~/lib/shared/contracts/status-plugin';
import ConfirmDialog from '~/lib/shared/ui/ConfirmDialog.svelte';
import { REPOSITORY_SPLIT_MEDIA_QUERY } from '~/lib/shared/ui/layout';
import { isUiOverlayOpen } from '~/lib/shared/ui/overlay';
import type { TerminalPathInsertionRequest, WorkspaceEntryDragData } from '~/lib/shared/lib/workspace-entry-drag.ts';
import MoveConflictDialog from '~/lib/features/repository/ui/MoveConflictDialog.svelte';
import RepositoryPanel from '~/lib/features/repository/ui/RepositoryPanel.svelte';
import RepositoryViewer from '~/lib/features/repository/ui/RepositoryViewer.svelte';
import WorkspaceNoteEditor from '~/lib/features/workspace/ui/WorkspaceNoteEditor.svelte';
import UploadConflictDialog from '~/lib/features/repository/ui/UploadConflictDialog.svelte';
import { uploadSelectionFromDataTransfer } from '~/lib/features/repository/api/upload';
import { RepositoryWorkspaceState } from '~/lib/features/repository/model/workspace-state.svelte';
import type { RepositorySelection, RepositoryTab } from '~/lib/shared/contracts/repository';

let {
  workspace,
  onStartBackground,
  onStopBackground,
  onLoadBackgroundOutput,
  onFavoriteBackground,
  onRemoveBackgroundFavorite,
  startingBackground = false,
  stoppingBackgroundProcessId,
  updatingFavoriteCommand,
  backgroundActionError = '',
  close,
  onLogout,
  onUpdateNote,
  onLoadNote,
  onSummarizeNote,
  onInputActivity,
  onOutputActivity,
  onTerminalPresentationChange = () => undefined,
  statusPlugins = [],
  mobilePanel,
  onMobilePanelChange = () => undefined,
  repositoryPanelOpen = false,
  onRepositoryPanelOpenChange = () => undefined,
  repositoryTab = 'changes',
  onRepositoryTabChange = () => undefined,
  kingAvailable = false,
  onKingControlChange = () => undefined,
}: {
  workspace: ManagedWorkspace;
  onStartBackground: (command: string) => Promise<WorkspaceTerminal | undefined>;
  onStopBackground: (process: WorkspaceTerminal) => Promise<boolean>;
  onLoadBackgroundOutput: (processId: string) => Promise<string>;
  onFavoriteBackground: (command: string) => Promise<boolean>;
  onRemoveBackgroundFavorite: (command: string) => Promise<boolean>;
  startingBackground?: boolean;
  stoppingBackgroundProcessId?: string;
  updatingFavoriteCommand?: string;
  backgroundActionError?: string;
  close: () => void;
  onLogout?: () => void;
  onUpdateNote: (workspaceId: string, note: string) => Promise<void>;
  onLoadNote: (workspaceId: string, refresh?: boolean) => Promise<string>;
  onSummarizeNote: (workspaceId: string) => Promise<{ notePath: string }>;
  onInputActivity: (workspaceId: string, timestamp: number) => void;
  onOutputActivity: (workspaceId: string, active: boolean, timestamp?: number) => void;
  onTerminalPresentationChange?: (workspaceId: string, presented: boolean) => void;
  statusPlugins?: StatusPluginSnapshot[];
  mobilePanel?: MobilePanel;
  onMobilePanelChange?: (panel: MobilePanel | undefined) => void;
  repositoryPanelOpen?: boolean;
  onRepositoryPanelOpenChange?: (open: boolean) => void;
  repositoryTab?: RepositoryTab;
  onRepositoryTabChange?: (tab: RepositoryTab) => void;
  kingAvailable?: boolean;
  onKingControlChange?: (control: NonNullable<ManagedWorkspace['kingControl']>) => void;
} = $props();

let desktop = $state(false);
let notePanelOpen = $state(false);
let pathInsertionRequest = $state<TerminalPathInsertionRequest>();
let pathInsertionToken = 0;
const name = $derived(workspaceName(workspace));
const repositoryOpen = $derived(desktop ? repositoryPanelOpen : mobilePanel === 'repository');
const noteOpen = $derived(desktop ? notePanelOpen : mobilePanel === 'note');
const sidePanelOpen = $derived(repositoryOpen || noteOpen);
const repository = new RepositoryWorkspaceState(
  untrack(() => workspace.id),
  { isOpen: () => repositoryOpen }
);

function toggleRepository() {
  if (repositoryOpen) {
    void closeRepository();
    return;
  }
  closeNotePanel();
  onRepositoryPanelOpenChange(true);
  if (!desktop) onMobilePanelChange('repository');
}

function closeNotePanel() {
  notePanelOpen = false;
  if (!desktop && mobilePanel === 'note') onMobilePanelChange(undefined);
}

function hideRepositoryPanel() {
  onRepositoryPanelOpenChange(false);
  if (!desktop && mobilePanel === 'repository') onMobilePanelChange(undefined);
}

function openNotePanel() {
  notePanelOpen = true;
  if (!desktop) onMobilePanelChange('note');
}

async function toggleNote() {
  if (noteOpen) {
    closeNotePanel();
    return;
  }
  if (repositoryOpen && !(await closeRepository())) return;
  openNotePanel();
}

async function closeRepository(): Promise<boolean> {
  if (!(await repository.confirmDiscardChanges())) return false;
  hideRepositoryPanel();
  repository.clearSelection();
  return true;
}

async function openWorkspaceNavigator() {
  if (repositoryOpen) {
    if (!(await closeRepository())) return;
  } else if (noteOpen) {
    closeNotePanel();
  } else if (!(await repository.confirmDiscardChanges())) {
    return;
  }
  close();
}

async function selectRepositoryItem(selection: RepositorySelection) {
  if (!(await repository.selectItem(selection))) return;
  if (selection.kind === 'file') {
    onRepositoryTabChange('files');
  }
  if (!desktop) {
    hideRepositoryPanel();
  }
}

async function editRepositoryFile(path: string) {
  if (!(await repository.editFile(path))) return;
  if (!desktop) hideRepositoryPanel();
}

async function createFile(directory: string, name: string) {
  await repository.createFile(directory, name);
  if (!desktop) hideRepositoryPanel();
}

async function insertPathIntoTerminal(entry: WorkspaceEntryDragData) {
  if (!desktop && !(await closeRepository())) return;
  pathInsertionRequest = { entries: [entry], token: ++pathInsertionToken };
}

async function addDroppedFilesToTerminal(dataTransfer: DataTransfer): Promise<WorkspaceEntryDragData[]> {
  return repository.addFilesForTerminal(await uploadSelectionFromDataTransfer(dataTransfer));
}

$effect(() => {
  const workspaceId = workspace.id;
  const presented = !repository.selection && !noteOpen;
  // Keep parent activity state out of this effect's dependency graph.
  untrack(() => onTerminalPresentationChange(workspaceId, presented));
  return () => untrack(() => onTerminalPresentationChange(workspaceId, false));
});

$effect(() => {
  if (!repositoryOpen) return;
  const refreshWhenVisible = () => {
    if (!document.hidden) void repository.refresh();
  };
  untrack(() => void repository.refresh());
  document.addEventListener('visibilitychange', refreshWhenVisible);

  return () => {
    document.removeEventListener('visibilitychange', refreshWhenVisible);
  };
});

onMount(() => {
  const desktopQuery = window.matchMedia(REPOSITORY_SPLIT_MEDIA_QUERY);
  const syncDesktop = () => (desktop = desktopQuery.matches);
  const closeOverlay = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    if (isUiOverlayOpen()) return;
    const target = event.target instanceof Element ? event.target : undefined;
    if (target?.closest('[data-inline-repository-entry]')) return;
    if (repositoryOpen) {
      if (!target?.closest('.repository-panel')) return;
      event.preventDefault();
      void closeRepository();
    } else if (noteOpen) {
      if (!target?.closest('.workspace-note-panel')) return;
      event.preventDefault();
      closeNotePanel();
    } else if (repository.selection) {
      event.preventDefault();
      void repository.closeViewer();
    }
  };
  syncDesktop();
  desktopQuery.addEventListener('change', syncDesktop);
  window.addEventListener('keydown', closeOverlay, { capture: true });

  return () => {
    desktopQuery.removeEventListener('change', syncDesktop);
    window.removeEventListener('keydown', closeOverlay, { capture: true });
    repository.resolveDiscardChanges(false);
  };
});
</script>

<section class="workspace-workbench" class:repository-open={repositoryOpen} class:side-panel-open={sidePanelOpen}>
  <div class="workspace-primary">
    <Terminal
      {workspace}
      {onStartBackground}
      {onStopBackground}
      {onLoadBackgroundOutput}
      {onFavoriteBackground}
      {onRemoveBackgroundFavorite}
      {startingBackground}
      {stoppingBackgroundProcessId}
      {updatingFavoriteCommand}
      {backgroundActionError}
      close={openWorkspaceNavigator}
      {onLogout}
      {onInputActivity}
      {onOutputActivity}
      {repositoryOpen}
      {noteOpen}
      isGitRepository={repository.snapshot?.isGitRepository ?? workspace.isGitRepository}
      changeCount={repository.changeCount}
      worktreeCount={repository.worktreeCount}
      onRepositoryStatus={(changeCount, worktreeCount) => repository.handleStatus(changeCount, worktreeCount)}
      onToggleRepository={toggleRepository}
      onToggleNote={() => void toggleNote()}
      {pathInsertionRequest}
      onExternalFileDrop={addDroppedFilesToTerminal}
      dismissStatusPopovers={!desktop && mobilePanel !== undefined}
      {statusPlugins}
      {kingAvailable}
      {onKingControlChange}
    >
      {#if repository.selection}
        <RepositoryViewer
          workspaceId={workspace.id}
          selection={repository.selection}
          refreshToken={repository.refreshToken}
          initialFile={repository.openedFile}
          onClose={() => repository.closeViewer()}
          onEditFile={editRepositoryFile}
          onRequestDiscardChange={(path) => repository.requestDiscardChange(path)}
          onFileSaved={(file) => repository.handleFileSaved(file)}
          onFileDirtyChange={(dirty) => (repository.fileDirty = dirty)}
        />
      {/if}
    </Terminal>
  </div>

  {#if sidePanelOpen && !desktop}
    <button
      class="workspace-panel-scrim"
      type="button"
      aria-label="Dismiss workspace panel"
      onclick={() => void (repositoryOpen ? closeRepository() : closeNotePanel())}
    ></button>
  {/if}

  <RepositoryPanel
    projectName={name}
    snapshot={repository.snapshot}
    loading={repository.loading}
    errorMessage={repository.errorMessage}
    uploading={repository.uploading}
    moving={repository.moving}
    uploadNoticeKind={repository.uploadNoticeKind}
    uploadNotice={repository.uploadNotice}
    selected={repository.selection}
    activeTab={repositoryTab}
    open={repositoryOpen}
    onRefresh={() => void repository.refresh(true)}
    onLoadDirectory={(path) => repository.loadDirectory(path)}
    onCreateFile={createFile}
    onCreateDirectory={(directory, name) => repository.createDirectory(directory, name)}
    onRequestDelete={(path, kind) => repository.requestDelete(path, kind)}
    onRequestDiscardChange={(change) => repository.requestDiscardChange(change)}
    onMoveEntry={(entry, directory) => repository.moveEntry(entry.path, entry.kind, directory)}
    onInsertPath={(entry) => void insertPathIntoTerminal(entry)}
    onUploadSelection={(selection, directory) => repository.uploadFiles(selection, directory)}
    onUploadError={(message) => repository.reportUploadError(message)}
    onClose={closeRepository}
    onSelect={selectRepositoryItem}
    onTabChange={onRepositoryTabChange}
  />

  <aside
    class="workspace-note-panel"
    class:open={noteOpen}
    aria-label={`Workspace note for ${name}`}
    aria-hidden={!noteOpen}
    inert={!noteOpen}
  >
    <WorkspaceNoteEditor
      panel
      getNote={(refresh) => onLoadNote(workspace.id, refresh)}
      save={(note) => onUpdateNote(workspace.id, note)}
      summarize={() => onSummarizeNote(workspace.id)}
      close={closeNotePanel}
    />
  </aside>

  {#if repository.discardChangesPrompt}
    <ConfirmDialog
      title="Discard unsaved changes?"
      description="Your edits to the open file have not been saved. Discard them and continue?"
      confirmLabel="Discard changes"
      busyLabel="Discarding…"
      close={() => repository.resolveDiscardChanges(false)}
      onConfirm={async () => repository.resolveDiscardChanges(true)}
    />
  {/if}

  {#if repository.deleteTarget}
    <ConfirmDialog
      title={repository.deleteTarget.kind === 'directory' ? 'Delete folder?' : 'Delete file?'}
      description={repository.deleteDescription(repository.deleteTarget)}
      confirmLabel={repository.deleteTarget.kind === 'directory' ? 'Delete folder' : 'Delete file'}
      busyLabel="Deleting…"
      close={() => (repository.deleteTarget = undefined)}
      onConfirm={() => repository.confirmDelete()}
    />
  {/if}

  {#if repository.uploadConflicts.length > 0}
    <UploadConflictDialog
      count={repository.uploadConflicts.length}
      firstPath={repository.uploadConflicts[0]?.path ?? ''}
      onResolve={(conflict) => repository.resolveUploadConflicts(conflict)}
    />
  {/if}

  {#if repository.moveConflict}
    <MoveConflictDialog
      path={repository.moveConflict.path}
      kind={repository.moveConflict.kind}
      targetDirectory={repository.moveConflict.targetDirectory}
      onResolve={async (resolution) => {
				await repository.resolveMoveConflict(resolution);
			}}
    />
  {/if}

  {#if repository.discardTarget}
    <ConfirmDialog
      title={repository.discardChangeTitle(repository.discardTarget)}
      description={repository.discardChangeDescription(repository.discardTarget)}
      confirmLabel={repository.discardTarget.status === '??' ? 'Delete file' : 'Discard changes'}
      busyLabel={repository.discardTarget.status === '??' ? 'Deleting…' : 'Discarding…'}
      close={() => (repository.discardTarget = undefined)}
      onConfirm={() => repository.confirmDiscardChange()}
    />
  {/if}
</section>

<style>
.workspace-workbench,
.workspace-primary {
  width: 100%;
  min-width: 0;
  min-height: 0;
}
.workspace-workbench {
  position: relative;
  height: 100%;
  overflow: hidden;
  --workspace-panel-width: min(22rem, calc(100% - 3rem));
}
.workspace-primary {
  position: relative;
  height: 100%;
}
.workspace-panel-scrim {
  position: fixed;
  z-index: 39;
  inset: 0;
  padding: 0;
  border: 0;
  background: var(--color-backdrop);
  cursor: pointer;
  animation: workspace-panel-scrim-in 180ms ease;
}

@keyframes workspace-panel-scrim-in {
  from {
    opacity: 0;
  }
}

.workspace-note-panel {
  position: absolute;
  z-index: 10;
  top: 0;
  right: 0;
  display: flex;
  flex-direction: column;
  width: var(--workspace-panel-width);
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
.workspace-note-panel.open {
  transform: translateX(0);
  pointer-events: auto;
}
.workspace-note-panel :global(.note-editor.panel) {
  flex: 1 1 auto;
  width: auto;
  min-width: 0;
  min-height: 0;
  overflow: auto;
}

@media (min-width: 80rem) {
  .workspace-workbench {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 0fr;
  }
  .workspace-workbench.side-panel-open {
    grid-template-columns: minmax(0, 1fr) var(--workspace-panel-width);
  }
  .workspace-primary {
    grid-column: 1;
    grid-row: 1;
  }
  .workspace-note-panel {
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
  .workspace-note-panel.open {
    visibility: visible;
  }
}

@media (width < 80rem) {
  .workspace-workbench {
    --workspace-panel-width: min(23rem, calc(100% - 2.75rem));
  }
  .workspace-note-panel {
    position: fixed;
    z-index: 40;
    width: var(--workspace-panel-width);
    height: 100dvh;
    padding-top: env(safe-area-inset-top);
    padding-bottom: env(safe-area-inset-bottom);
    transition: transform 180ms ease;
  }
}

@media (prefers-reduced-motion: reduce) {
  .workspace-panel-scrim {
    animation: none;
  }
  .workspace-note-panel {
    transition: none;
  }
}
</style>
