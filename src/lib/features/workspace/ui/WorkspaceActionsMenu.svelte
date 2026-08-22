<script lang="ts">
import { DropdownMenu } from 'bits-ui';
import Clock3 from '@lucide/svelte/icons/clock-3';
import Ellipsis from '@lucide/svelte/icons/ellipsis';
import GitBranchPlus from '@lucide/svelte/icons/git-branch-plus';
import LogOut from '@lucide/svelte/icons/log-out';
import Tags from '@lucide/svelte/icons/tags';
import SquarePlay from '@lucide/svelte/icons/square-play';
import Trash2 from '@lucide/svelte/icons/trash-2';
import DropdownMenuShell from '~/lib/shared/ui/DropdownMenuShell.svelte';
import type { ManagedWorkspace } from '~/lib/shared/contracts/workspace';
import { isWorktreeWorkspace, workspaceName } from '../model/workspace-view';

let {
  workspace,
  open = false,
  onOpenChange,
  action,
  closeWorkspace,
  remove,
  onSettings,
  onAlias,
  onNewWorktree,
  onAutomations,
}: {
  workspace: ManagedWorkspace;
  open?: boolean;
  onOpenChange: (open: boolean) => void;
  action?: 'restart' | 'close' | 'remove';
  closeWorkspace: (workspace: ManagedWorkspace) => Promise<{ ok: boolean; error?: string }>;
  remove: (workspace: ManagedWorkspace) => Promise<{ ok: boolean; error?: string }>;
  onSettings: (workspace: ManagedWorkspace) => void;
  onAlias: (workspace: ManagedWorkspace) => void;
  onNewWorktree: (workspace: ManagedWorkspace) => void;
  onAutomations: (workspace: ManagedWorkspace) => void;
} = $props();

let confirming = $state<'close' | 'remove'>();
let confirmError = $state('');

function handleMenuOpenChange(nextOpen: boolean) {
  if (!nextOpen) {
    confirming = undefined;
    confirmError = '';
  }
  onOpenChange(nextOpen);
}

function requestConfirmation(event: Event, selectedAction: 'close' | 'remove') {
  event.preventDefault();
  if (action) return;
  confirmError = '';
  confirming = selectedAction;
}

async function confirmSelectedAction() {
  const selectedAction = confirming;
  if (!selectedAction || action) return;
  confirmError = '';
  const result = selectedAction === 'close' ? await closeWorkspace(workspace) : await remove(workspace);
  if (!result.ok) {
    confirmError =
      result.error || `Unable to ${selectedAction === 'close' ? 'close the workspace' : 'remove the workspace'}.`;
    return;
  }
  confirming = undefined;
  onOpenChange(false);
}
</script>

<DropdownMenuShell
  {open}
  onOpenChange={handleMenuOpenChange}
  triggerLabel={`Workspace actions for ${workspaceName(workspace)}`}
  triggerTitle="Workspace actions"
>
  {#snippet trigger()}
    <Ellipsis size={18} strokeWidth={1.9} aria-hidden="true" />
  {/snippet}

  {#snippet children()}
    <div class="vampire-menu-heading" role="presentation">
      <strong>{workspaceName(workspace)}</strong>
      <span>{workspace.cwd}</span>
    </div>
    <DropdownMenu.Separator class="vampire-menu-separator" />

    {#if confirming}
      <div
        class="vampire-menu-confirm"
        role="group"
        aria-label={confirming === 'close' ? 'Confirm closing workspace' : 'Confirm removing workspace'}
      >
        <strong>{confirming === 'close' ? 'Close this workspace?' : 'Remove this workspace?'}</strong>
        <p>
          {#if confirming === 'close'}
            The shell and its processes will stop. The workspace stays available.
          {:else if isWorktreeWorkspace(workspace) && workspace.workspaceAvailable === false}
            Vampire will clear the missing working copy's Git registration. Its branch stays available.
          {:else if isWorktreeWorkspace(workspace)}
            {workspace.state === 'running' ? 'The running shell will stop. ' : ''}The managed working copy and any
            uncommitted files in it will be deleted. Its Git branch stays available.
          {:else if workspace.state === 'running'}
            The running shell will stop and the workspace will be removed. Project files stay on disk.
          {:else}
            The workspace will be removed from Vampire. Project files stay on disk.
          {/if}
        </p>
        <div class="vampire-menu-confirm-actions">
          <DropdownMenu.Item class="vampire-menu-item" onSelect={() => confirming = undefined}>
            Cancel
          </DropdownMenu.Item>
          <DropdownMenu.Item
            class="vampire-menu-item danger"
            disabled={Boolean(action)}
            onSelect={(event) => { event.preventDefault(); void confirmSelectedAction(); }}
          >
            {action ? (confirming === 'close' ? 'Closing…' : 'Removing…') : (confirming === 'close' ? 'Close workspace' : 'Remove workspace')}
          </DropdownMenu.Item>
        </div>
        {#if confirmError}
          <p class="vampire-menu-error" role="alert">{confirmError}</p>
        {/if}
      </div>
    {:else}
      <DropdownMenu.Item class="vampire-menu-item" onSelect={() => onAlias(workspace)}>
        <Tags size={16} strokeWidth={1.8} aria-hidden="true" />
        {workspace.workspaceLabel?.trim() ? 'Edit workspace alias' : 'Set workspace alias'}
      </DropdownMenu.Item>
      {#if workspace.isGitRepository && workspace.workspaceAvailable !== false}
        <DropdownMenu.Item class="vampire-menu-item" onSelect={() => onNewWorktree(workspace)}>
          <GitBranchPlus size={16} strokeWidth={1.8} aria-hidden="true" />
          New isolated workspace
        </DropdownMenu.Item>
      {/if}
      <DropdownMenu.Item class="vampire-menu-item" onSelect={() => onSettings(workspace)}>
        <SquarePlay size={16} strokeWidth={1.8} aria-hidden="true" />
        Startup profile
      </DropdownMenu.Item>
      <DropdownMenu.Item class="vampire-menu-item" onSelect={() => onAutomations(workspace)}>
        <Clock3 size={16} strokeWidth={1.8} aria-hidden="true" />
        Agent automations
      </DropdownMenu.Item>
      <DropdownMenu.Separator class="vampire-menu-separator" />
      {#if workspace.state === 'running'}
        <DropdownMenu.Item
          class="vampire-menu-item"
          disabled={Boolean(action)}
          onSelect={(event) => requestConfirmation(event, 'close')}
        >
          <LogOut size={16} strokeWidth={1.8} aria-hidden="true" />
          Close workspace
        </DropdownMenu.Item>
      {/if}
      <DropdownMenu.Item
        class="vampire-menu-item danger"
        disabled={Boolean(action)}
        onSelect={(event) => requestConfirmation(event, 'remove')}
      >
        <Trash2 size={16} strokeWidth={1.8} aria-hidden="true" />
        Remove workspace
      </DropdownMenu.Item>
    {/if}
  {/snippet}
</DropdownMenuShell>

<style>
.vampire-menu-confirm {
  display: grid;
  gap: 0.45rem;
  padding: 0.45rem 0.55rem 0.55rem;
}
.vampire-menu-confirm strong {
  color: var(--color-text);
  font-size: var(--text-label);
  font-weight: var(--weight-medium);
}
.vampire-menu-confirm p {
  margin: 0;
  color: var(--color-text-secondary);
  font-size: var(--text-caption);
  line-height: var(--leading-ui);
}
.vampire-menu-confirm-actions {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 0.3rem;
  margin-top: 0.2rem;
}
:global(.vampire-menu-confirm-actions .vampire-menu-item) {
  justify-content: center;
  min-height: 2rem;
  padding-inline: 0.35rem;
}
.vampire-menu-error {
  color: var(--color-danger-text) !important;
}
</style>
