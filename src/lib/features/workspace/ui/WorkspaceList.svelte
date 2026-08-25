<script lang="ts">
import { onMount, tick } from 'svelte';
import ChevronRight from '@lucide/svelte/icons/chevron-right';
import CirclePlay from '@lucide/svelte/icons/circle-play';
import FolderX from '@lucide/svelte/icons/folder-x';
import GitBranch from '@lucide/svelte/icons/git-branch';
import SquareTerminal from '@lucide/svelte/icons/square-terminal';
import StickyNote from '@lucide/svelte/icons/sticky-note';
import Button from '~/lib/shared/ui/Button.svelte';
import WorkspaceActionsMenu from './WorkspaceActionsMenu.svelte';
import type { ManagedWorkspace, WorkspaceOrderMode } from '~/lib/shared/contracts/workspace';
import type { WorkspaceActivityRecords, WorkspaceActivityState } from '../model/workspace-view';
import {
  formatWorkspaceTimestamp,
  isWorktreeWorkspace,
  latestWorkspaceOutputAt,
  workspaceActivityHint,
  workspaceActivityLabel,
  workspaceActivityState,
  workspaceProcess,
  workspaceProcessColor,
  workspaceProcessHint,
  workspaceName,
  workspaceRepositoryName,
} from '../model/workspace-view';

let {
  workspaces,
  displayedWorkspaces,
  selectedWorkspaceId,
  activityRecords,
  errorMessage,
  workspaceOrderMode,
  onReorder,
  onOpen,
  workspaceAction,
  onCloseWorkspace,
  onRemoveWorkspace,
  onSettings,
  onAlias,
  onNewWorktree,
  onAutomations,
  onNewWorkspace,
}: {
  workspaces: ManagedWorkspace[];
  displayedWorkspaces: ManagedWorkspace[];
  selectedWorkspaceId?: string;
  activityRecords: WorkspaceActivityRecords;
  errorMessage: string;
  workspaceOrderMode: WorkspaceOrderMode;
  onReorder: (draggedId: string, targetId: string, position: 'before' | 'after') => void;
  onOpen: (workspace: ManagedWorkspace) => void;
  workspaceAction?: 'restart' | 'close' | 'remove';
  onCloseWorkspace: (workspace: ManagedWorkspace) => Promise<{ ok: boolean; error?: string }>;
  onRemoveWorkspace: (workspace: ManagedWorkspace) => Promise<{ ok: boolean; error?: string }>;
  onSettings: (workspace: ManagedWorkspace) => void;
  onAlias: (workspace: ManagedWorkspace) => void;
  onNewWorktree: (workspace: ManagedWorkspace) => void;
  onAutomations: (workspace: ManagedWorkspace) => void;
  onNewWorkspace: () => void;
} = $props();

const SMART_ACTIVITY_GROUPS: { state: WorkspaceActivityState; label: string }[] = [
  { state: 'active', label: 'Working' },
  { state: 'review', label: 'Review needed' },
  { state: 'idle', label: 'Idle' },
  { state: 'ended', label: 'Ended' },
];

let draggedWorkspaceId = $state<string>();
let dragOverWorkspaceId = $state<string>();
let dropPosition = $state<'before' | 'after'>('before');
let openActionWorkspaceId = $state<string>();
let endedGroupExpanded = $state(false);
let now = $state(Date.now());
const smartActivityGroups = $derived(
  SMART_ACTIVITY_GROUPS.map((group) => ({
    ...group,
    workspaces: displayedWorkspaces.filter(
      (workspace) => workspaceActivityState(workspace, activityRecords, now) === group.state
    ),
  }))
);
const selectedEndedWorkspace = $derived(
  displayedWorkspaces.some(
    (workspace) =>
      workspace.id === selectedWorkspaceId && workspaceActivityState(workspace, activityRecords, now) === 'ended'
  )
);

$effect(() => {
  if (selectedEndedWorkspace && workspaceAction !== 'close') endedGroupExpanded = true;
});

onMount(() => {
  const timer = window.setInterval(() => (now = Date.now()), 1_000);
  return () => window.clearInterval(timer);
});

function beginWorkspaceDrag(event: DragEvent, workspaceId: string) {
  if (workspaceOrderMode !== 'manual' || !event.dataTransfer) return;
  draggedWorkspaceId = workspaceId;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', workspaceId);
}

function updateWorkspaceDropTarget(event: DragEvent, workspaceId: string) {
  if (!draggedWorkspaceId || draggedWorkspaceId === workspaceId) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
  dragOverWorkspaceId = workspaceId;
  dropPosition = event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after';
}

function dropWorkspace(event: DragEvent, workspaceId: string) {
  event.preventDefault();
  if (draggedWorkspaceId) onReorder(draggedWorkspaceId, workspaceId, dropPosition);
  endWorkspaceDrag();
}

function endWorkspaceDrag() {
  draggedWorkspaceId = undefined;
  dragOverWorkspaceId = undefined;
}

function handleWorkspaceOrderKeydown(event: KeyboardEvent, workspaceId: string) {
  if (workspaceOrderMode !== 'manual' || !event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
  event.preventDefault();
  const index = displayedWorkspaces.findIndex((workspace) => workspace.id === workspaceId);
  const target = displayedWorkspaces[index + (event.key === 'ArrowUp' ? -1 : 1)];
  if (target) onReorder(workspaceId, target.id, event.key === 'ArrowUp' ? 'before' : 'after');
}

function handleWorkspaceContextMenu(event: MouseEvent, workspace: ManagedWorkspace) {
  event.preventDefault();
  openActionWorkspaceId = workspace.id;
}

function handleWorkspaceActionsOpen(workspaceId: string, open: boolean) {
  if (open) openActionWorkspaceId = workspaceId;
  else if (openActionWorkspaceId === workspaceId) openActionWorkspaceId = undefined;
}

async function openWorkspaceDialog(workspace: ManagedWorkspace, callback: (workspace: ManagedWorkspace) => void) {
  openActionWorkspaceId = undefined;
  await tick();
  callback(workspace);
}

async function runWorkspaceAction(
  workspace: ManagedWorkspace,
  callback: (workspace: ManagedWorkspace) => Promise<{ ok: boolean; error?: string }>
): Promise<{ ok: boolean; error?: string }> {
  const result = await callback(workspace);
  if (result.ok && openActionWorkspaceId === workspace.id) openActionWorkspaceId = undefined;
  return result;
}
</script>

{#snippet workspaceRows(groupWorkspaces: ManagedWorkspace[])}
  {#each groupWorkspaces as workspace (workspace.id)}
    {@const activityState = workspaceActivityState(workspace, activityRecords, now)}
    {@const process = workspaceProcess(workspace)}
    {@const backgroundCount = Math.max(0, workspace.terminals.length - 1)}
    {@const displayName = workspaceName(workspace)}
    {@const repositoryName = workspaceRepositoryName(workspace)}
    <div
      class="workspace-row-shell"
      class:selected={selectedWorkspaceId === workspace.id}
      class:dragging={draggedWorkspaceId === workspace.id}
      class:dropBefore={dragOverWorkspaceId === workspace.id && dropPosition === 'before'}
      class:dropAfter={dragOverWorkspaceId === workspace.id && dropPosition === 'after'}
      role="group"
      draggable={workspaceOrderMode === 'manual'}
      ondragstart={(event) => beginWorkspaceDrag(event, workspace.id)}
      ondragover={(event) => updateWorkspaceDropTarget(event, workspace.id)}
      ondrop={(event) => dropWorkspace(event, workspace.id)}
      ondragend={endWorkspaceDrag}
      title={workspaceOrderMode === 'manual' ? 'Drag to reorder, or use Alt + Up/Down' : undefined}
    >
      <button
        class="workspace-row"
        class:missing={workspace.state === 'missing'}
        onclick={() => onOpen(workspace)}
        oncontextmenu={(event) => handleWorkspaceContextMenu(event, workspace)}
        onkeydown={(event) => handleWorkspaceOrderKeydown(event, workspace.id)}
        aria-current={selectedWorkspaceId === workspace.id ? 'true' : undefined}
        aria-label={`Open ${workspace.state === 'missing' ? 'ended' : 'running'} ${displayName} workspace (${process?.label ? `${process.label}; ` : ''}${workspaceActivityHint(workspace, activityRecords, now)}; ${backgroundCount} background ${backgroundCount === 1 ? 'process' : 'processes'}${workspace.workspaceAvailable === false ? '; working copy missing' : ''}${workspace.notePreview ? '; has a note' : ''})`}
      >
        <span class="workspace-summary">
          <span class="workspace-title" title={displayName}>
            <strong>{displayName}</strong>
          </span>
          {#if isWorktreeWorkspace(workspace)}
            <span
              class="workspace-origin"
              title={`${repositoryName}${workspace.worktreeBranch ? ` · ${workspace.worktreeBranch}` : ' · Git worktree'}`}
            >
              <GitBranch size={12} strokeWidth={1.8} aria-hidden="true" />
              <span>{repositoryName}</span>
              {#if workspace.worktreeBranch}
                <span class="workspace-context-divider" aria-hidden="true">·</span>
                <span>{workspace.worktreeBranch}</span>
              {/if}
            </span>
          {/if}
          {#if workspace.workspaceAvailable === false}
            <span class="workspace-missing" title="The working directory was removed outside Vampire.">
              <FolderX size={12} strokeWidth={1.8} aria-hidden="true" />
              <span>Working copy missing</span>
            </span>
          {/if}
          <span class="agent-summary" title={workspaceActivityHint(workspace, activityRecords, now)}>
            <span
              class="status-dot"
              class:output-active={activityState === 'active'}
              class:review={activityState === 'review'}
              class:ended={activityState === 'ended'}
              aria-hidden="true"
            ></span>
            {#if process}
              <span
                class="workspace-program"
                style={`--workspace-program-color: ${workspaceProcessColor(process)}`}
                title={workspaceProcessHint(workspace)}
                >{process.label}</span
              >
              <span class="workspace-context-divider" aria-hidden="true">·</span>
            {/if}
            {#if workspaceOrderMode === 'manual'}
              <span class={`workspace-state ${activityState}`}>{workspaceActivityLabel(activityState)}</span>
              <span class="workspace-context-divider" aria-hidden="true">·</span>
            {/if}
            <time
              datetime={new Date(latestWorkspaceOutputAt(workspace)).toISOString()}
              title={`Main terminal update ${new Date(latestWorkspaceOutputAt(workspace)).toLocaleString()}`}
              >{formatWorkspaceTimestamp(latestWorkspaceOutputAt(workspace), now)}</time
            >
          </span>
          {#if backgroundCount > 0}
            <span
              class="runtime-summary"
              title={`${backgroundCount} background ${backgroundCount === 1 ? 'process' : 'processes'} in this workspace`}
            >
              <CirclePlay size={13} strokeWidth={1.7} aria-hidden="true" />
              <span>{backgroundCount} background</span>
            </span>
          {/if}
          {#if workspace.notePreview}
            <span class="workspace-note-preview" title={workspace.notePreview}>
              <StickyNote size={12} strokeWidth={1.8} aria-hidden="true" />
              <span>{workspace.notePreview}</span>
            </span>
          {/if}
        </span>
      </button>
      <div class="workspace-actions-menu">
        <WorkspaceActionsMenu
          {workspace}
          open={openActionWorkspaceId === workspace.id}
          onOpenChange={(open) => handleWorkspaceActionsOpen(workspace.id, open)}
          action={workspaceAction}
          closeWorkspace={(target) => runWorkspaceAction(target, onCloseWorkspace)}
          remove={(target) => runWorkspaceAction(target, onRemoveWorkspace)}
          onSettings={(target) => void openWorkspaceDialog(target, onSettings)}
          onAlias={(target) => void openWorkspaceDialog(target, onAlias)}
          onNewWorktree={(target) => void openWorkspaceDialog(target, onNewWorktree)}
          onAutomations={(target) => void openWorkspaceDialog(target, onAutomations)}
        />
      </div>
    </div>
  {/each}
{/snippet}

{#if errorMessage}
  <p class="error panel-message" role="alert">{errorMessage}</p>
{:else if workspaces.length === 0}
  <div class="empty-state">
    <div class="empty-state__icon" aria-hidden="true"><SquareTerminal size={24} strokeWidth={1.7} /></div>
    <h2>No workspaces yet</h2>
    <p>Open a project shell. The workspace stays available until you remove it.</p>
    <Button variant="secondary" onclick={onNewWorkspace}>New workspace</Button>
  </div>
{:else}
  <div class="workspaces">
    {#if workspaceOrderMode === 'activity'}
      {#each smartActivityGroups as group (group.state)}
        {#if group.workspaces.length > 0}
          <section
            class="workspace-group"
            class:working={group.state === 'active'}
            class:review={group.state === 'review'}
            class:idle={group.state === 'idle'}
            class:ended={group.state === 'ended'}
            aria-labelledby={`workspace-group-${group.state}`}
          >
            {#if group.state === 'ended'}
              <button
                class="workspace-group-header workspace-group-toggle"
                type="button"
                onclick={() => endedGroupExpanded = !endedGroupExpanded}
                aria-expanded={endedGroupExpanded}
                aria-controls="ended-workspace-group"
              >
                <span id="workspace-group-ended">{group.label}</span>
                <span class="workspace-group-count">{group.workspaces.length}</span>
                <ChevronRight
                  class={endedGroupExpanded ? 'expanded' : undefined}
                  size={14}
                  strokeWidth={1.8}
                  aria-hidden="true"
                />
              </button>
              {#if endedGroupExpanded}
                <div id="ended-workspace-group">{@render workspaceRows(group.workspaces)}</div>
              {/if}
            {:else}
              <h2 class="workspace-group-header" id={`workspace-group-${group.state}`}>
                <span>{group.label}</span>
                <span class="workspace-group-count">{group.workspaces.length}</span>
              </h2>
              {@render workspaceRows(group.workspaces)}
            {/if}
          </section>
        {/if}
      {/each}
    {:else}
      {@render workspaceRows(displayedWorkspaces)}
    {/if}
  </div>
{/if}

<style>
.workspaces {
  border-top: 1px solid var(--color-border);
}
.workspace-group-header {
  display: flex;
  align-items: center;
  gap: 0.38rem;
  min-height: 1.8rem;
  margin: 0;
  padding: 0.35rem 1rem 0.3rem;
  border: 0;
  background: var(--color-panel);
  color: var(--color-text-tertiary);
  font: inherit;
  font-size: var(--text-nano);
  font-weight: var(--weight-medium);
  letter-spacing: 0.065em;
  line-height: var(--leading-ui);
  text-transform: uppercase;
}
.workspace-group.working .workspace-group-header {
  color: var(--color-warning-accent);
}
.workspace-group.review .workspace-group-header {
  color: var(--color-info-text);
}
.workspace-group.idle .workspace-group-header {
  color: var(--color-success-text);
}
.workspace-group-count {
  color: var(--color-text-disabled);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0;
}
.workspace-group-toggle {
  width: 100%;
  text-align: left;
  cursor: pointer;
}
@media (hover: hover) {
  .workspace-group-toggle:hover {
    background: var(--color-surface-raised);
    color: var(--color-text-secondary);
  }
}
.workspace-group-toggle :global(svg) {
  margin-left: auto;
  transition: transform 150ms ease;
}
.workspace-group-toggle :global(svg.expanded) {
  transform: rotate(90deg);
}
.workspace-row-shell {
  position: relative;
  min-width: 0;
  border-bottom: 1px solid var(--color-border);
}
.workspace-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  align-items: start;
  width: 100%;
  min-width: 0;
  min-height: 4.15rem;
  padding: 0.65rem 3.25rem 0.65rem 1rem;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
@media (hover: hover) {
  .workspace-row:hover {
    background: var(--color-surface-raised);
  }
  .workspace-row-shell.selected .workspace-row:hover {
    background: var(--color-surface-active-hover);
  }
}
.workspace-row-shell.selected {
  background: var(--color-surface-active);
  box-shadow: inset 0.18rem 0 var(--color-accent);
}
.workspace-row-shell[draggable="true"] {
  cursor: grab;
}
.workspace-row-shell.dragging {
  opacity: 0.42;
  cursor: grabbing;
}
.workspace-row-shell.dropBefore::before,
.workspace-row-shell.dropAfter::after {
  position: absolute;
  z-index: 4;
  right: 0.65rem;
  left: 0.65rem;
  height: 2px;
  border-radius: 2px;
  background: var(--color-accent);
  content: "";
}
.workspace-row-shell.dropBefore::before {
  top: 0;
}
.workspace-row-shell.dropAfter::after {
  bottom: -1px;
}
.workspace-actions-menu {
  position: absolute;
  z-index: 3;
  top: 0.55rem;
  right: 0.55rem;
}
.workspace-summary {
  display: grid;
  min-width: 0;
  gap: 0.25rem;
}
.workspace-title {
  display: flex;
  align-items: center;
  min-width: 0;
  min-height: 1.4rem;
  padding-right: 0.25rem;
}
.workspace-title strong {
  min-width: 0;
  overflow: hidden;
  color: var(--color-text);
  font-size: var(--text-body);
  font-weight: var(--weight-medium);
  line-height: var(--leading-tight);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.agent-summary,
.runtime-summary,
.workspace-note-preview,
.workspace-origin,
.workspace-missing {
  display: flex;
  align-items: center;
  min-width: 0;
  overflow: hidden;
  font-size: var(--text-caption);
  line-height: var(--leading-ui);
  white-space: nowrap;
}
.workspace-origin {
  gap: 0.3rem;
  color: var(--color-text-tertiary);
}
.workspace-origin :global(svg),
.workspace-missing :global(svg) {
  flex: 0 0 auto;
}
.workspace-origin span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.workspace-origin span:last-child {
  color: var(--color-text-disabled);
  font-family: var(--font-mono);
  font-size: var(--text-micro);
}
.workspace-missing {
  gap: 0.32rem;
  color: var(--color-warning-accent);
}
.agent-summary {
  gap: 0.34rem;
  color: var(--color-text-tertiary);
}
.status-dot {
  box-sizing: border-box;
  flex: 0 0 auto;
  width: 0.52rem;
  height: 0.52rem;
  border-radius: 50%;
  background: var(--color-success);
  box-shadow: none;
}
.status-dot.output-active {
  background: var(--color-warning);
  box-shadow: var(--shadow-status-active);
  animation: activity-pulse 1.4s ease-out infinite;
}
.status-dot.review {
  border: 0.11rem solid var(--color-info);
  background: transparent;
  box-shadow: var(--shadow-status-review);
}
.status-dot.ended {
  border: 0.1rem solid var(--color-status-missing);
  background: transparent;
  box-shadow: none;
}
.workspace-program {
  flex: 0 0 auto;
  color: var(--workspace-program-color, var(--color-text-secondary));
  font-weight: var(--weight-medium);
}
.workspace-state {
  flex: 0 0 auto;
  color: var(--color-text-tertiary);
}
.workspace-state.active {
  color: var(--color-warning-accent);
}
.workspace-state.review {
  color: var(--color-info-text);
}
.workspace-state.ended {
  color: var(--color-text-disabled);
}
.workspace-context-divider {
  flex: 0 0 auto;
  color: var(--color-text-disabled);
}
.agent-summary time {
  min-width: 0;
  overflow: hidden;
  color: var(--color-text-disabled);
  font-variant-numeric: tabular-nums;
  text-overflow: ellipsis;
}
.runtime-summary {
  gap: 0.32rem;
  color: var(--color-text-tertiary);
}
.runtime-summary :global(svg) {
  flex: 0 0 auto;
  color: var(--color-text-disabled);
}
.workspace-note-preview {
  gap: 0.32rem;
  color: var(--color-note);
}
.workspace-note-preview :global(svg) {
  flex: 0 0 auto;
}
.workspace-note-preview span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.workspace-row.missing .workspace-summary {
  opacity: 0.62;
}
.empty-state {
  display: grid;
  justify-items: start;
  padding: clamp(1.25rem, 4vw, 2rem) 1rem 1.5rem;
  border-top: 1px solid var(--color-border);
}
.empty-state__icon {
  margin-bottom: 0.75rem;
  color: var(--color-accent);
}
.empty-state h2 {
  margin: 0;
  font-size: var(--text-heading);
  font-weight: var(--weight-strong);
  line-height: var(--leading-tight);
}
.empty-state p {
  max-width: 28rem;
  margin: 0.35rem 0 0.9rem;
  color: var(--color-text-secondary);
  font-size: var(--text-body);
  line-height: var(--leading-body);
}
.error {
  margin: 0;
  color: var(--color-danger);
  font-size: var(--text-label);
  line-height: var(--leading-ui);
}
.panel-message {
  margin: 0 1.35rem 1.35rem;
}

@keyframes activity-pulse {
  0%,
  45% {
    box-shadow: var(--shadow-status-active-pulse);
  }
  100% {
    box-shadow: var(--shadow-status-active-clear);
  }
}

@media (min-width: 64rem) {
  .workspaces,
  .empty-state {
    min-height: 0;
    overflow-y: auto;
  }
  .workspaces {
    flex: 1 1 0;
  }
}

@media (max-width: 63.999rem) {
  .workspaces,
  .empty-state {
    min-height: 0;
    overflow-y: auto;
  }
  .workspaces {
    flex: 1 1 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .status-dot.output-active {
    animation: none;
  }
  .workspace-group-toggle :global(svg) {
    transition: none;
  }
}
</style>
