import { expect, test, vi } from 'vitest';
import { WorkspaceState } from './workspace-state.svelte.ts';
import type { ManagedWorkspace } from '~/lib/shared/contracts/workspace.ts';

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

test('creates King with the selected launch profile and opens the King workspace', async () => {
  const king = workspace('king', {
    cwd: '/tmp/state/king',
    workspaceKind: 'king',
    workspaceLabel: 'King',
    startupProfileId: 'codex',
  });
  const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    requests.push({ input, init });
    if (init?.method === 'POST') {
      return new Response(JSON.stringify({ workspace: king }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ workspaces: [king], preferences: null, launchProfiles: [] }), {
      headers: { 'content-type': 'application/json' },
    });
  });
  const navigate = vi.fn();
  const current = new WorkspaceState({
    navigate,
    onUnauthorized: vi.fn(),
    isWorkspaceObserved: () => false,
  });

  await expect(current.createKingWorkspace('codex', true)).resolves.toBe(true);

  const createRequest = requests.find((request) => request.init?.method === 'POST');
  expect(String(createRequest?.input)).toMatch(/\/api\/workspaces\/king$/);
  expect(JSON.parse(String(createRequest?.init?.body))).toEqual({ launchProfileId: 'codex' });
  expect(current.workspaces[0]).toMatchObject({ workspaceKind: 'king', workspaceLabel: 'King' });
  expect(navigate).toHaveBeenCalledWith('/workspaces/king');
  expect(current.creatingKing).toBe(false);
  expect(current.kingCreateError).toBe('');
  current.dispose();
});
