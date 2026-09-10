import { workspaceName } from '@vampire/lib/features/workspace/model/workspace-view.ts';
import type { ManagedWorkspace } from '@vampire/lib/shared/contracts/workspace.ts';
import { ArrowLeft, ChevronDown, FolderX, RotateCcw, SquareTerminal } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { Button, Dialog, DropdownMenu, DropdownMenuItem } from '~/shared/ui/index.ts';
import type { WorkspaceState } from './model/workspace-state.ts';
import './unavailable-workspace.css';

export const UnavailableWorkspace = observer(function UnavailableWorkspace({
  state,
  workspace,
}: {
  state: WorkspaceState;
  workspace: ManagedWorkspace;
}) {
  const [profilesOpen, setProfilesOpen] = useState(false);
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);
  const missingDirectory = workspace.workspaceAvailable === false;
  const busy = Boolean(state.workspaceAction);
  const reopen = async (profile?: string | null) => {
    if (busy) return;
    await state.restartWorkspace(workspace, profile);
  };
  return (
    <section className="unavailable-workspace" aria-labelledby="unavailable-title">
      <header>
        <Button
          variant="icon"
          aria-label="Open workspaces"
          title="Open workspaces"
          onClick={() => state.clearActiveWorkspace()}
        >
          <ArrowLeft size={18} aria-hidden="true" />
        </Button>
        <strong>{workspaceName(workspace)}</strong>
      </header>
      <div className="unavailable-body">
        <div className="unavailable-content">
          <span className="unavailable-icon" aria-hidden="true">
            {missingDirectory ? (
              <FolderX size={25} strokeWidth={1.5} />
            ) : (
              <SquareTerminal size={25} strokeWidth={1.5} />
            )}
          </span>
          <p className="unavailable-eyebrow">{missingDirectory ? 'Directory unavailable' : 'Workspace offline'}</p>
          <h1 id="unavailable-title">{missingDirectory ? 'This working copy was removed' : 'This shell has ended'}</h1>
          <p className="unavailable-description">
            {missingDirectory
              ? 'The working directory could not be found. Choose another workspace to continue, or remove this entry from your list.'
              : 'The terminal session is no longer running. Reopen a fresh shell to continue in this project.'}
          </p>
          <div className="unavailable-location">
            <span>Working directory</span>
            <code>{workspace.cwd}</code>
          </div>
          <div className="unavailable-actions">
            {!missingDirectory ? (
              <>
                <Button variant="primary" disabled={busy} onClick={() => void reopen()}>
                  <RotateCcw size={15} aria-hidden="true" />
                  {state.workspaceAction === 'restart' ? 'Reopening…' : 'Reopen shell'}
                </Button>
                <DropdownMenu
                  open={profilesOpen}
                  onOpenChange={(open) => setProfilesOpen(open && !busy)}
                  label="Reopen with…"
                  triggerClassName="unavailable-profile-trigger"
                  trigger={
                    <>
                      <span>Reopen with…</span>
                      <ChevronDown size={14} aria-hidden="true" />
                    </>
                  }
                >
                  <DropdownMenuItem disabled={busy} onSelect={() => void reopen(null)}>
                    Blank terminal
                  </DropdownMenuItem>
                  {state.launchProfiles.map((profile) => (
                    <DropdownMenuItem key={profile.id} disabled={busy} onSelect={() => void reopen(profile.id)}>
                      {profile.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenu>
              </>
            ) : (
              <Button variant="primary" onClick={() => state.clearActiveWorkspace()}>
                Open workspaces
              </Button>
            )}
          </div>
          {state.workspaceActionError ? (
            <p className="unavailable-error" role="alert">
              {state.workspaceActionError}
            </p>
          ) : null}
          <div className="unavailable-footer">
            <span>No longer needed?</span>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmingRemoval(true)}>
              {state.workspaceAction === 'remove' ? 'Removing…' : 'Remove workspace'}
            </Button>
          </div>
        </div>
      </div>
      {confirmingRemoval ? (
        <Dialog
          open
          role="alertdialog"
          title="Remove this workspace?"
          busy={busy}
          onClose={() => {
            if (!busy) setConfirmingRemoval(false);
          }}
          footer={
            <>
              <Button variant="ghost" disabled={busy} data-autofocus onClick={() => setConfirmingRemoval(false)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                disabled={busy}
                onClick={() =>
                  void state.removeWorkspace(workspace).then((removed) => {
                    if (removed) setConfirmingRemoval(false);
                  })
                }
              >
                {busy ? 'Removing…' : 'Remove workspace'}
              </Button>
            </>
          }
        >
          <p>Remove {workspaceName(workspace)} from your workspace list?</p>
          {state.workspaceActionError ? <p role="alert">{state.workspaceActionError}</p> : null}
        </Dialog>
      ) : null}
    </section>
  );
});
