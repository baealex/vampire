<script lang="ts">
import Plus from '@lucide/svelte/icons/plus';
import WorkspaceList from './WorkspaceList.svelte';
import WorkspaceNavigatorHeader from './WorkspaceNavigatorHeader.svelte';
import WorkspaceDirectoryPicker from './WorkspaceDirectoryPicker.svelte';
import type { ManagedWorkspace, WorkspaceOrderMode } from '~/lib/shared/contracts/workspace';
import type { WorkspaceActivityRecords } from '../model/workspace-view';

let {
  workspaces,
  displayedWorkspaces,
  selectedWorkspaceId,
  activityRecords,
  hasOpenWorkspace,
  mobileOpen,
  errorMessage,
  workspaceOrderMode,
  workspacePreferencesError,
  newWorkspaceOpen = $bindable(),
  cwd = $bindable(),
  starting,
  startError,
  tmuxAvailable,
  onClose,
  onOrderModeChange,
  onReorder,
  onOpen,
  workspaceAction,
  onCloseWorkspace,
  onRemoveWorkspace,
  onSettings,
  onAlias,
  onNewWorktree,
  onAutomations,
  onCreate,
}: {
  workspaces: ManagedWorkspace[];
  displayedWorkspaces: ManagedWorkspace[];
  selectedWorkspaceId?: string;
  activityRecords: WorkspaceActivityRecords;
  hasOpenWorkspace: boolean;
  mobileOpen: boolean;
  errorMessage: string;
  workspaceOrderMode: WorkspaceOrderMode;
  workspacePreferencesError: string;
  newWorkspaceOpen: boolean;
  cwd: string;
  starting: boolean;
  startError: string;
  tmuxAvailable?: boolean;
  onClose: () => void;
  onOrderModeChange: (mode: WorkspaceOrderMode) => void;
  onReorder: (draggedId: string, targetId: string, position: 'before' | 'after') => void;
  onOpen: (workspace: ManagedWorkspace) => void;
  workspaceAction?: 'restart' | 'close' | 'remove';
  onCloseWorkspace: (workspace: ManagedWorkspace) => Promise<{ ok: boolean; error?: string }>;
  onRemoveWorkspace: (workspace: ManagedWorkspace) => Promise<{ ok: boolean; error?: string }>;
  onSettings: (workspace: ManagedWorkspace) => void;
  onAlias: (workspace: ManagedWorkspace) => void;
  onNewWorktree: (workspace: ManagedWorkspace) => void;
  onAutomations: (workspace: ManagedWorkspace) => void;
  onCreate: () => void;
} = $props();

function openNewWorkspace() {
  newWorkspaceOpen = true;
}

function createWorkspace(path: string) {
  cwd = path;
  onCreate();
}
</script>

{#if mobileOpen && hasOpenWorkspace}
  <button class="workspace-scrim" type="button" aria-label="Close workspaces" onclick={onClose}></button>
{/if}

<div class="workspace-column" class:mobile-open={mobileOpen} class:standalone={!hasOpenWorkspace}>
  <section class="workspace-panel" aria-label="Workspace list">
    <WorkspaceNavigatorHeader
      {hasOpenWorkspace}
      {workspaceOrderMode}
      {workspacePreferencesError}
      {onClose}
      {onOrderModeChange}
    />
    <WorkspaceList
      {workspaces}
      {displayedWorkspaces}
      {selectedWorkspaceId}
      {activityRecords}
      {errorMessage}
      {workspaceOrderMode}
      {onReorder}
      {onOpen}
      {workspaceAction}
      {onCloseWorkspace}
      {onRemoveWorkspace}
      {onSettings}
      {onAlias}
      {onNewWorktree}
      {onAutomations}
      onNewWorkspace={openNewWorkspace}
    />
  </section>

  <section class="new-workspace-panel" aria-labelledby="new-workspace-title">
    <button class="new-workspace-toggle" type="button" onclick={openNewWorkspace}>
      <span class="new-workspace-toggle__icon" aria-hidden="true"><Plus size={14} strokeWidth={2.1} /></span>
      <strong id="new-workspace-title">New workspace</strong>
    </button>
  </section>

  {#if newWorkspaceOpen}
    <WorkspaceDirectoryPicker
      initialPath={cwd}
      {starting}
      {startError}
      {tmuxAvailable}
      close={() => newWorkspaceOpen = false}
      onCreate={createWorkspace}
    />
  {/if}
</div>

<style>
.workspace-column {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 20rem;
  align-items: start;
  gap: 1.25rem;
  min-width: 0;
}
.workspace-scrim {
  display: none;
}
.workspace-panel,
.new-workspace-panel {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-surface);
}
.workspace-panel {
  min-width: 0;
  overflow: hidden;
}
.new-workspace-panel {
  overflow: hidden;
}
.new-workspace-toggle {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 0.65rem;
  width: 100%;
  min-height: 3.5rem;
  padding: 0.5rem 1rem;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
@media (hover: hover) {
  .new-workspace-toggle:hover {
    background: var(--color-surface-raised);
  }
}
.new-workspace-toggle__icon {
  display: grid;
  place-items: center;
  width: 1.4rem;
  height: 1.4rem;
  border-radius: 50%;
  background: var(--color-accent);
  color: var(--color-accent-ink);
}
.new-workspace-toggle strong {
  font-size: var(--text-label);
  font-weight: var(--weight-medium);
}

@media (min-width: 64rem) {
  .workspace-column {
    display: flex;
    flex-direction: column;
    gap: 0;
    min-width: 0;
    height: 100%;
    overflow: hidden;
    border-right: 1px solid var(--color-border);
    background: var(--color-panel);
  }
  .workspace-panel,
  .new-workspace-panel {
    width: 100%;
    border: 0;
    border-radius: 0;
    background: transparent;
  }
  .workspace-panel {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    min-height: 0;
  }
  .new-workspace-panel {
    position: relative;
    z-index: 1;
    flex: 0 0 auto;
    border-top: 1px solid var(--color-border);
    background: var(--color-panel);
  }
  .new-workspace-toggle {
    min-height: 3.25rem;
    padding-block: 0.4rem;
  }
}

@media (max-width: 63.999rem) {
  .workspace-scrim {
    position: fixed;
    z-index: 39;
    inset: 0;
    display: block;
    padding: 0;
    border: 0;
    background: var(--color-backdrop);
    cursor: pointer;
    animation: workspace-scrim-in 180ms ease;
  }
  .workspace-column {
    position: fixed;
    z-index: 40;
    inset: 0 auto 0 0;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 0;
    width: min(23rem, calc(100% - 2.75rem));
    height: 100dvh;
    padding: env(safe-area-inset-top) 0 env(safe-area-inset-bottom);
    overflow-y: auto;
    transform: translateX(-100%);
    border-right: 1px solid var(--color-border-strong);
    background: var(--color-panel);
    box-shadow: var(--shadow-navigation-panel);
    pointer-events: none;
    transition:
      transform 180ms ease,
      visibility 0s linear 180ms;
    visibility: hidden;
  }
  .workspace-column.standalone {
    width: 100%;
  }
  .workspace-column.mobile-open {
    transform: translateX(0);
    pointer-events: auto;
    transition: transform 180ms ease;
    visibility: visible;
  }
  .workspace-panel,
  .new-workspace-panel {
    width: 100%;
    border: 0;
    border-radius: 0;
    background: transparent;
  }
  .workspace-panel {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    min-height: 0;
  }
  .new-workspace-panel {
    position: relative;
    z-index: 1;
    flex: 0 0 auto;
    border-top: 1px solid var(--color-border);
    background: var(--color-panel);
  }
}

@media (prefers-reduced-motion: reduce) {
  .workspace-column {
    transition: none;
  }
  .workspace-scrim {
    animation: none;
  }
}

@keyframes workspace-scrim-in {
  from {
    opacity: 0;
  }
}
</style>
