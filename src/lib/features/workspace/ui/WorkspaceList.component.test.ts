import { render, screen } from '@testing-library/svelte';
import { expect, test, vi } from 'vitest';
import WorkspaceList from './WorkspaceList.svelte';
import type { ManagedWorkspace } from '~/lib/shared/contracts/workspace.ts';

function workspace(id: string, overrides: Partial<ManagedWorkspace> = {}): ManagedWorkspace {
  return {
    id,
    tmuxSession: `vampire-${id}`,
    cwd: `/tmp/${id}`,
    createdAt: 1,
    lastActiveAt: 1,
    notePreview: '',
    favoriteCommands: [],
    startupProfileId: null,
    lastOutputAt: null,
    state: 'running',
    attachedClients: 0,
    foregroundProcess: null,
    terminals: [],
    agentState: null,
    isGitRepository: false,
    ...overrides,
  };
}

test('renders The King of Vampire in a dedicated section without duplicating the header identity badge', () => {
  const regular = workspace('regular');
  const king = workspace('king', {
    workspaceKind: 'king',
    workspaceLabel: 'King',
    cwd: '/tmp/state/king',
  });
  const { container } = render(WorkspaceList, {
    workspaces: [regular, king],
    displayedWorkspaces: [king, regular],
    activityRecords: new Map(),
    errorMessage: '',
    workspaceOrderMode: 'activity',
    onReorder: vi.fn(),
    onOpen: vi.fn(),
    onCloseWorkspace: vi.fn(),
    onRemoveWorkspace: vi.fn(),
    onSettings: vi.fn(),
    onAlias: vi.fn(),
    onNewWorktree: vi.fn(),
    onAutomations: vi.fn(),
    onNewWorkspace: vi.fn(),
  });

  expect(screen.getByRole('heading', { name: 'KING WORKSPACE' })).toBeInTheDocument();
  expect(screen.getByText('The King of Vampire')).toBeInTheDocument();
  expect(container.querySelector('.workspace-king-badge')).toBeNull();
  expect(screen.getByRole('button', { name: /Open running The King of Vampire workspace/ })).toBeInTheDocument();
});

test('shows delegated King agents on their owning workspace instead of counting them as background jobs', () => {
  const regular = workspace('regular', {
    terminals: [
      {
        id: '@1',
        index: 0,
        name: 'main',
        active: true,
        lastOutputAt: 1,
        foregroundProcess: { kind: 'command', label: 'codex' },
        command: null,
        startedAt: 1,
        state: 'running',
        exitCode: null,
        terminalKind: 'main',
        kingAttemptId: null,
      },
      {
        id: '@2',
        index: 1,
        name: 'King task 11111111',
        active: false,
        lastOutputAt: 2,
        foregroundProcess: { kind: 'command', label: 'codex' },
        command: null,
        startedAt: 2,
        state: 'running',
        exitCode: null,
        terminalKind: 'king-task',
        kingAttemptId: '11111111-1111-4111-8111-111111111111',
      },
    ],
  });
  render(WorkspaceList, {
    workspaces: [regular],
    displayedWorkspaces: [regular],
    activityRecords: new Map(),
    errorMessage: '',
    workspaceOrderMode: 'activity',
    onReorder: vi.fn(),
    onOpen: vi.fn(),
    onCloseWorkspace: vi.fn(),
    onRemoveWorkspace: vi.fn(),
    onSettings: vi.fn(),
    onAlias: vi.fn(),
    onNewWorktree: vi.fn(),
    onAutomations: vi.fn(),
    onNewWorkspace: vi.fn(),
  });

  expect(screen.getByText('1 King agent')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /1 King agent; 0 background processes/ })).toBeInTheDocument();
  expect(screen.queryByText('1 background')).not.toBeInTheDocument();
});
