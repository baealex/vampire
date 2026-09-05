import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import type { ManagedWorkspace } from '~/lib/shared/contracts/workspace.ts';
import WorkspaceActionsMenu from './WorkspaceActionsMenu.svelte';

const workspace: ManagedWorkspace = {
  id: 'workspace-1',
  tmuxSession: 'vampire-workspace-1',
  cwd: '/projects/vampire',
  workspaceKind: 'worktree',
  repositoryPath: '/projects/vampire-main',
  worktreeBranch: 'feature/component-tests',
  createdAt: 1,
  lastActiveAt: 1,
  notePreview: 'Release blocker',
  composerPromptPreview: null,
  favoriteCommands: [],
  startupProfileId: null,
  lastOutputAt: null,
  state: 'running',
  attachedClients: 0,
  foregroundProcess: null,
  terminals: [],
  isGitRepository: true,
};

test('requires confirmation before removal and keeps a failed removal retryable', async () => {
  const user = userEvent.setup();
  const remove = vi
    .fn<(workspace: ManagedWorkspace) => Promise<{ ok: boolean; error?: string }>>()
    .mockResolvedValueOnce({ ok: false, error: 'Working copy removal failed.' })
    .mockResolvedValueOnce({ ok: true });
  const onOpenChange = vi.fn();

  render(WorkspaceActionsMenu, {
    workspace,
    open: true,
    onOpenChange,
    action: undefined,
    closeWorkspace: vi.fn(async () => ({ ok: true })),
    remove,
    onSettings: vi.fn(),
    onNewWorktree: vi.fn(),
    onAutomations: vi.fn(),
  });

  await user.click(await screen.findByRole('menuitem', { name: 'Remove workspace' }));

  expect(remove).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Confirm removing workspace')).toBeInTheDocument();
  expect(screen.getByText(/uncommitted files in it will be deleted/i)).toBeInTheDocument();
  expect(screen.getByText(/Vampire note will also be deleted/i)).toBeInTheDocument();

  await fireEvent.click(screen.getByText('Remove workspace'));

  expect(await screen.findByText('Working copy removal failed.')).toHaveAttribute('role', 'alert');
  expect(remove).toHaveBeenCalledTimes(1);
  expect(onOpenChange).not.toHaveBeenCalledWith(false);

  await fireEvent.click(screen.getByText('Remove workspace'));

  await waitFor(() => expect(remove).toHaveBeenCalledTimes(2));
  expect(remove).toHaveBeenLastCalledWith(workspace);
  expect(onOpenChange).toHaveBeenLastCalledWith(false);
});

test('does not warn about note deletion when the workspace note is empty', async () => {
  const user = userEvent.setup();

  render(WorkspaceActionsMenu, {
    workspace: { ...workspace, notePreview: '' },
    open: true,
    onOpenChange: vi.fn(),
    action: undefined,
    closeWorkspace: vi.fn(async () => ({ ok: true })),
    remove: vi.fn(async () => ({ ok: true })),
    onSettings: vi.fn(),
    onNewWorktree: vi.fn(),
    onAutomations: vi.fn(),
  });

  await user.click(await screen.findByRole('menuitem', { name: 'Remove workspace' }));

  expect(screen.queryByText(/Vampire note will also be deleted/i)).not.toBeInTheDocument();
});
