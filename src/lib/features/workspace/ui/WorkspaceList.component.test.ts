import { render, screen, waitFor } from '@testing-library/svelte';
import { expect, test, vi } from 'vitest';
import type { ManagedWorkspace } from '~/lib/shared/contracts/workspace.ts';
import WorkspaceList from './WorkspaceList.svelte';

function workspace(state: ManagedWorkspace['state']): ManagedWorkspace {
  return {
    id: 'workspace-1',
    tmuxSession: 'vampire-workspace-1',
    cwd: '/projects/vampire',
    createdAt: 1,
    lastActiveAt: 1,
    notePreview: '',
    favoriteCommands: [],
    startupProfileId: null,
    lastOutputAt: null,
    state,
    attachedClients: 0,
    foregroundProcess: null,
    terminals: [],
    isGitRepository: false,
  };
}

function props(currentWorkspace: ManagedWorkspace, workspaceAction?: 'close') {
  return {
    workspaces: [currentWorkspace],
    displayedWorkspaces: [currentWorkspace],
    selectedWorkspaceId: currentWorkspace.id,
    activityRecords: new Map(),
    errorMessage: '',
    workspaceOrderMode: 'activity' as const,
    onReorder: vi.fn(),
    onOpen: vi.fn(),
    workspaceAction,
    onCloseWorkspace: vi.fn(async () => ({ ok: true })),
    onRemoveWorkspace: vi.fn(async () => ({ ok: true })),
    onSettings: vi.fn(),
    onAlias: vi.fn(),
    onNewWorktree: vi.fn(),
    onAutomations: vi.fn(),
    onNewWorkspace: vi.fn(),
  };
}

test('keeps Ended collapsed while the selected workspace is being explicitly closed', async () => {
  const running = workspace('running');
  const view = render(WorkspaceList, props(running));

  await view.rerender(props({ ...running, state: 'missing' }, 'close'));

  const endedToggle = screen.getByRole('button', { name: /Ended/ });
  await waitFor(() => expect(endedToggle).toHaveAttribute('aria-expanded', 'false'));
  expect(screen.queryByRole('button', { name: /Open ended/ })).not.toBeInTheDocument();
});

test('reveals Ended when the selected workspace terminates outside the close action', async () => {
  const running = workspace('running');
  const view = render(WorkspaceList, props(running));

  await view.rerender(props({ ...running, state: 'missing' }));

  const endedToggle = screen.getByRole('button', { name: /Ended/ });
  await waitFor(() => expect(endedToggle).toHaveAttribute('aria-expanded', 'true'));
  expect(screen.getByRole('button', { name: /Open ended/ })).toBeInTheDocument();
});
