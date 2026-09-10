import { SquareTerminal } from 'lucide-react';
import { useState } from 'react';
import type { ManagedWorkspace } from '@vampire/lib/shared/contracts/workspace.ts';
import { workspaceName } from '@vampire/lib/features/workspace/model/workspace-view.ts';
import { Button, DropdownMenu, DropdownMenuItem } from '~/shared/ui/index.ts';
import type { WorkspaceState } from './model/workspace-state.ts';
import './unavailable-workspace.css';

export function UnavailableWorkspace({ state, workspace }: { state: WorkspaceState; workspace: ManagedWorkspace }) {
  const [profilesOpen, setProfilesOpen] = useState(false);
  const reopen = async (profile?: string | null) => {
    await state.restartWorkspace(workspace, profile);
  };
  return (
    <section className="unavailable-workspace">
      <header>
        <Button variant="ghost" onClick={() => state.clearActiveWorkspace()}>
          Open workspaces
        </Button>
        <strong>{workspaceName(workspace)}</strong>
        <code>{workspace.cwd}</code>
      </header>
      <div>
        <span>
          <SquareTerminal size={22} />
        </span>
        <p>{workspace.workspaceAvailable === false ? 'working copy unavailable' : 'tmux session unavailable'}</p>
        <h2>{workspace.workspaceAvailable === false ? 'This working copy was removed' : 'This shell has ended'}</h2>
        <p>
          {workspace.workspaceAvailable === false
            ? 'The terminal ended and its working directory no longer exists. Its Git branch remains available.'
            : 'Open a fresh shell in the same project or remove this workspace from the list.'}
        </p>
        <code>{workspace.cwd}</code>
        <div>
          {workspace.workspaceAvailable !== false ? (
            <>
              <Button variant="primary" disabled={Boolean(state.workspaceAction)} onClick={() => void reopen()}>
                {state.workspaceAction === 'restart' ? 'Reopening…' : 'Reopen shell'}
              </Button>
              <DropdownMenu
                open={profilesOpen}
                onOpenChange={setProfilesOpen}
                label="Reopen with…"
                trigger={<span>Reopen with…</span>}
              >
                <DropdownMenuItem onSelect={() => void reopen(null)}>Blank terminal</DropdownMenuItem>
                {state.launchProfiles.map((profile) => (
                  <DropdownMenuItem key={profile.id} onSelect={() => void reopen(profile.id)}>
                    {profile.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenu>
            </>
          ) : null}
          <Button
            variant="danger-outline"
            disabled={Boolean(state.workspaceAction)}
            onClick={() => void state.removeWorkspace(workspace)}
          >
            {state.workspaceAction === 'remove' ? 'Removing…' : 'Remove workspace'}
          </Button>
        </div>
        {state.workspaceActionError ? <p role="alert">{state.workspaceActionError}</p> : null}
      </div>
    </section>
  );
}
