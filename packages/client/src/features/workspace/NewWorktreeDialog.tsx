import { workspaceName, workspaceRepositoryName } from '@vampire/lib/features/workspace/model/workspace-view.ts';
import type { ManagedWorkspace } from '@vampire/lib/shared/contracts/workspace.ts';
import { GitBranchPlus } from 'lucide-react';
import { useState } from 'react';
import { Button, Dialog, Field, Input } from '~/shared/ui/index.ts';
import type { WorkspaceState } from './model/workspace-state.ts';

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
          <Button variant="primary" disabled={creating || !name.trim()} onClick={() => void create()}>
            {creating ? 'Creating…' : 'Create workspace'}
          </Button>
        </>
      }
    >
      <div className="settings-fields">
        <div className="worktree-intro">
          <GitBranchPlus size={20} />
          <span>
            <strong>Start a separate task from {workspaceName(source)}</strong>
            <p>
              Vampire creates a new branch and linked working directory from the current commit. Uncommitted changes are
              not copied.
            </p>
          </span>
        </div>
        <Field label="Task name" description={`Repository: ${workspaceRepositoryName(source)}`}>
          <Input value={name} maxLength={80} onChange={(event) => setName(event.currentTarget.value)} autoFocus />
        </Field>
        <p>
          The startup profile and favorite background commands are inherited. Removing the workspace keeps its Git
          branch.
        </p>
        {error ? <p role="alert">{error}</p> : null}
      </div>
    </Dialog>
  );
}
