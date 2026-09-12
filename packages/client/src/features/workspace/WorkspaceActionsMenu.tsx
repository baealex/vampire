import { workspaceName } from '@vampire/lib/features/workspace/model/workspace-view.ts';
import type { ManagedWorkspace } from '@vampire/lib/shared/contracts/workspace.ts';
import { Ellipsis, GitBranchPlus, LogOut, Settings2, Trash2 } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { DropdownMenu, DropdownMenuItem, DropdownMenuSeparator } from '~/shared/ui/index.ts';
import type { WorkspaceState } from './model/workspace-state.ts';
import './workspace-actions-menu.css';

export const WorkspaceActionsMenu = observer(function WorkspaceActionsMenu({
  onNewWorktree,
  onOpenChange,
  onSettings,
  open,
  state,
  workspace,
}: {
  onNewWorktree: () => void;
  onOpenChange: (open: boolean) => void;
  onSettings: () => void;
  open: boolean;
  state: WorkspaceState;
  workspace: ManagedWorkspace;
}) {
  const [confirming, setConfirming] = useState<'close' | 'remove'>();
  const run = async () => {
    if (!confirming || state.workspaceAction) return;
    const ok = confirming === 'close' ? await state.closeWorkspace(workspace) : await state.removeWorkspace(workspace);
    if (ok) {
      setConfirming(undefined);
      onOpenChange(false);
    }
  };
  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setConfirming(undefined);
      }}
      label={`Workspace actions for ${workspaceName(workspace)}`}
      title="Workspace actions"
      align="end"
      trigger={<Ellipsis size={18} strokeWidth={1.9} aria-hidden="true" />}
    >
      {confirming ? (
        <div
          className="workspace-menu-confirm"
          role="group"
          aria-label={confirming === 'close' ? 'Confirm closing workspace' : 'Confirm removing workspace'}
        >
          <strong>{confirming === 'close' ? 'Close this workspace?' : 'Remove this workspace?'}</strong>
          <p>
            {confirming === 'close'
              ? 'The shell and its processes will stop. The workspace stays available.'
              : 'The workspace will be removed from Vampire. Project files stay on disk.'}
          </p>
          <div>
            <DropdownMenuItem onSelect={() => setConfirming(undefined)}>Cancel</DropdownMenuItem>
            <DropdownMenuItem
              danger
              disabled={Boolean(state.workspaceAction)}
              onSelect={(event) => {
                event.preventDefault();
                void run();
              }}
            >
              {state.workspaceAction ? 'Working…' : confirming === 'close' ? 'Close workspace' : 'Remove workspace'}
            </DropdownMenuItem>
          </div>
          {state.workspaceActionError ? <p role="alert">{state.workspaceActionError}</p> : null}
        </div>
      ) : (
        <>
          <DropdownMenuItem onSelect={onSettings}>
            <Settings2 size={16} aria-hidden="true" />
            Workspace settings
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {workspace.isGitRepository && workspace.workspaceAvailable !== false ? (
            <DropdownMenuItem onSelect={onNewWorktree}>
              <GitBranchPlus size={16} aria-hidden="true" />
              New isolated workspace
            </DropdownMenuItem>
          ) : null}
          {workspace.state === 'running' ? (
            <DropdownMenuItem
              onSelect={(event) => {
                event.preventDefault();
                setConfirming('close');
              }}
            >
              <LogOut size={16} aria-hidden="true" />
              Close workspace
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            danger
            onSelect={(event) => {
              event.preventDefault();
              setConfirming('remove');
            }}
          >
            <Trash2 size={16} aria-hidden="true" />
            Remove workspace
          </DropdownMenuItem>
        </>
      )}
    </DropdownMenu>
  );
});
