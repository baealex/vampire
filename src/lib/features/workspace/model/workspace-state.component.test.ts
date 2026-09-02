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
    composerPromptPreview: null,
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

test('records a Composer prompt and caches its workspace history', async () => {
  const prompt = { id: 'prompt-1', text: 'Continue the current work', submittedAt: 200 };
  const preview = { text: prompt.text, submittedAt: prompt.submittedAt };
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    if (init?.method === 'POST') return json({ saved: true, prompt, preview });
    return json({ prompts: [prompt] });
  });
  const current = state();
  current.applyWorkspaceSnapshot([workspace('one')]);

  await current.recordWorkspaceComposerPrompt('one', prompt.text);
  expect(current.workspaces[0]?.composerPromptPreview).toEqual(preview);
  await expect(current.loadWorkspaceComposerPrompts('one')).resolves.toEqual([prompt]);
  await expect(current.loadWorkspaceComposerPrompts('one')).resolves.toEqual([prompt]);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  current.dispose();
});

test('applies server Composer history settings and stops recording when disabled', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const path = String(input);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    if (path === '/api/composer-history/settings' && init?.method === 'PUT') {
      return json({ enabled: false, limit: 8 });
    }
    if (path === '/api/workspaces') {
      return json({
        workspaces: [workspace('one')],
        composerHistorySettings: { enabled: false, limit: 8 },
      });
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  const current = state();
  current.applyWorkspaceSnapshot([
    workspace('one', { composerPromptPreview: { text: 'Existing prompt', submittedAt: 1 } }),
  ]);

  await expect(current.updateComposerHistorySettings({ enabled: false, limit: 8 })).resolves.toEqual({ ok: true });
  await current.recordWorkspaceComposerPrompt('one', 'Do not record this');

  expect(current.composerHistorySettings).toEqual({ enabled: false, limit: 8 });
  expect(current.workspaces[0]?.composerPromptPreview).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  current.dispose();
});

test('saves workspace settings together and applies the returned template locally', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(
      JSON.stringify({
        startupProfileId: 'codex',
        composerTemplate: 'Read AGENTS.md.\n\n{{ prompts }}',
      }),
      { headers: { 'content-type': 'application/json' } }
    )
  );
  const current = state();
  current.applyWorkspaceSnapshot([workspace('one')]);

  await expect(current.updateWorkspaceSettings('one', 'codex', 'Read AGENTS.md.\n\n{{ prompts }}')).resolves.toEqual({
    ok: true,
  });

  expect(fetchMock).toHaveBeenCalledWith('/api/workspaces/one/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      startupProfileId: 'codex',
      composerTemplate: 'Read AGENTS.md.\n\n{{ prompts }}',
    }),
  });
  expect(current.workspaces[0]).toMatchObject({
    startupProfileId: 'codex',
    composerTemplate: 'Read AGENTS.md.\n\n{{ prompts }}',
  });
  current.dispose();
});
