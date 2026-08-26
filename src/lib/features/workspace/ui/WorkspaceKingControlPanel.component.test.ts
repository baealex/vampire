import { render, screen, waitFor } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import type { ManagedWorkspace, WorkspaceKingControl } from '~/lib/shared/contracts/workspace.ts';
import WorkspaceKingControlPanel from './WorkspaceKingControlPanel.svelte';

function workspace(control: WorkspaceKingControl): ManagedWorkspace {
  return {
    id: 'workspace-1',
    tmuxSession: 'worker-session',
    cwd: '/project-feature',
    workspaceKind: 'worktree',
    workspaceLabel: 'Feature worktree',
    worktreeBranch: 'feature/work',
    managedWorktree: false,
    checkoutKey: 'checkout-1',
    kingControl: control,
    createdAt: 1,
    lastActiveAt: 1,
    notePreview: '',
    favoriteCommands: [],
    startupProfileId: 'codex',
    lastOutputAt: 1,
    state: 'running',
    attachedClients: 0,
    foregroundProcess: { kind: 'command', label: 'codex' },
    terminals: [],
    isGitRepository: true,
    workspaceAvailable: true,
  };
}

function requestedControl(): WorkspaceKingControl {
  return {
    state: 'requested',
    reason: 'Continue the approved work in this existing worktree.',
    requestedAt: 1,
    changedAt: 1,
    lastAction: 'requested',
    notifiedAt: 1,
    handoffSnapshot: null,
  };
}

afterEach(() => vi.unstubAllGlobals());

test('hands an existing workspace to King from its crown control', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const granted: WorkspaceKingControl = {
    ...requestedControl(),
    state: 'king',
    lastAction: 'granted',
    changedAt: 2,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return new Response(JSON.stringify({ control: granted, interruptedAttemptIds: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    })
  );
  const onControlChange = vi.fn();
  const user = userEvent.setup();
  render(WorkspaceKingControlPanel, { workspace: workspace(requestedControl()), onControlChange });

  await user.click(screen.getByRole('button', { name: 'King requested workspace control' }));
  expect(await screen.findByText('Continue the approved work in this existing worktree.')).toBeInTheDocument();
  await user.click(screen.getByText('Hand over', { selector: 'button' }));

  await waitFor(() => expect(onControlChange).toHaveBeenCalledWith(granted));
  expect(requests[0]?.url).toContain('/api/workspaces/workspace-1/king-control');
  expect(typeof requests[0]?.init?.body).toBe('string');
  if (typeof requests[0]?.init?.body !== 'string') return;
  expect(JSON.parse(requests[0].init.body)).toEqual({ action: 'handoff' });
});
