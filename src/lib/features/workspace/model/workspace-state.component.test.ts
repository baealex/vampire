import { expect, test, vi } from 'vitest';
import type { ManagedWorkspace } from '~/lib/shared/contracts/workspace.ts';
import { WorkspaceState } from './workspace-state.svelte.ts';

function workspace(id: string, overrides: Partial<ManagedWorkspace> = {}): ManagedWorkspace {
  return {
    id,
    tmuxSession: `vampire-${id}`,
    cwd: `/tmp/${id}`,
    createdAt: 1,
    lastActiveAt: 100,
    notePreview: '',
    favoriteCommands: [],
    startupProfileId: null,
    lastOutputAt: 100,
    state: 'running',
    attachedClients: 0,
    foregroundProcess: null,
    terminals: [],
    agentState: null,
    isGitRepository: false,
    ...overrides,
  };
}

function state() {
  return new WorkspaceState({
    navigate: vi.fn(),
    onUnauthorized: vi.fn(),
    isWorkspaceObserved: () => false,
  });
}

test('does not let an older workspace update rewind activity timestamps', () => {
  const current = state();
  current.applyWorkspaceSnapshot([workspace('one')]);

  current.applyWorkspaceUpdated('one', {
    lastActiveAt: 50,
    lastOutputAt: 50,
    workspaceLabel: 'Renamed workspace',
  });

  expect(current.workspaces[0]).toMatchObject({
    lastActiveAt: 100,
    lastOutputAt: 100,
    workspaceLabel: 'Renamed workspace',
  });
  current.dispose();
});

test('clears the background busy state and exposes the API error after a failed start', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ message: 'background service unavailable' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    })
  );
  const current = state();
  current.applyWorkspaceSnapshot([workspace('one')]);

  await expect(current.startBackgroundProcess('one', 'pnpm test')).resolves.toBeUndefined();

  expect(current.startingBackgroundWorkspaceId).toBeUndefined();
  expect(current.backgroundActionError).toBe('background service unavailable');
  expect(current.backgroundActionErrorWorkspaceId).toBe('one');
  current.dispose();
});

test('places an isolated workspace below its source in shared manual order', async () => {
  const source = workspace('source');
  const tail = workspace('tail');
  const isolated = workspace('isolated', { workspaceKind: 'worktree' });
  let persistedOrder = ['source', 'tail'];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const path = String(input);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    if (path === '/api/workspaces/source/worktrees' && init?.method === 'POST') {
      return json({ workspace: isolated });
    }
    if (path === '/api/workspace-preferences' && init?.method === 'PUT') {
      const preferences = JSON.parse(String(init.body)) as {
        workspaceOrderMode: 'manual';
        manualWorkspaceOrder: string[];
      };
      persistedOrder = preferences.manualWorkspaceOrder;
      return json({ preferences });
    }
    if (path === '/api/workspaces') {
      return json({
        workspaces: [source, tail, isolated],
        preferences: { workspaceOrderMode: 'manual', manualWorkspaceOrder: persistedOrder },
      });
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  const current = state();
  current.applyWorkspaceSnapshot([source, tail]);
  current.applyWorkspacePreferences({ workspaceOrderMode: 'manual', manualWorkspaceOrder: persistedOrder });

  await expect(current.createIsolatedWorkspace('source', 'Parallel task')).resolves.toEqual({ ok: true });

  await vi.waitFor(() => expect(persistedOrder).toEqual(['source', 'isolated', 'tail']));
  expect(current.displayedWorkspaces.map((item) => item.id)).toEqual(['source', 'isolated', 'tail']);
  current.dispose();
});
