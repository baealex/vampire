import { workspaceName, workspaceRepositoryName } from '@vampire/lib/features/workspace/model/workspace-view.ts';
import type { ManagedWorkspace } from '@vampire/lib/shared/contracts/workspace.ts';
import { GitBranchPlus } from 'lucide-react';
import { useState } from 'react';
import { Button, Dialog, Field, Input } from '~/shared/ui/index.ts';
import type { WorkspaceState } from './model/workspace-state.ts';
import './new-worktree-dialog.css';

export function NewWorktreeDialog({
  onClose,
  source,
  state,
}: {
  onClose: () => void;
  source: ManagedWorkspace;
  state: WorkspaceState;
}) {
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const sourceName = workspaceName(source);
  const repositoryName = workspaceRepositoryName(source);
  const create = async () => {
    if (creating || !name.trim()) return;
    setCreating(true);
    const result = await state.createIsolatedWorkspace(source.id, name.trim());
    setCreating(false);
    if (result.ok) onClose();
    else setError(result.error ?? 'Unable to create the isolated workspace.');
  };
  return (
    <Dialog
      open
      title="New isolated workspace"
      busy={creating}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" disabled={creating} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="new-isolated-workspace-form"
            variant="primary"
            disabled={creating || !name.trim()}
          >
            {creating ? 'Creating…' : 'Create workspace'}
          </Button>
        </>
      }
    >
      <form
        id="new-isolated-workspace-form"
        className="new-worktree-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <div className="new-worktree-source">
          <span className="new-worktree-source__icon" aria-hidden="true">
            <GitBranchPlus size={20} strokeWidth={1.8} />
          </span>
          <div className="new-worktree-source__copy">
            <span className="new-worktree-source__eyebrow">Based on</span>
            <strong title={sourceName}>{sourceName}</strong>
            <small title={repositoryName}>{repositoryName}</small>
          </div>
        </div>
        <p className="new-worktree-lede">Create a separate working copy for a parallel task.</p>
        <Field label="Task name" description="Used for the workspace label and branch name.">
          <Input
            value={name}
            maxLength={80}
            onChange={(event) => {
              setName(event.currentTarget.value);
              if (error) setError('');
            }}
            placeholder="e.g. fix-login-flow"
            autoFocus
          />
        </Field>
        <p className="new-worktree-note">Starts from the current commit. Uncommitted changes are not copied.</p>
        {error ? (
          <p className="new-worktree-error" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}
