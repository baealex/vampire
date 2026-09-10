import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceState } from './workspace-state.ts';

const createState = () =>
  new WorkspaceState({ navigate: vi.fn(), onUnauthorized: vi.fn(), isWorkspaceObserved: () => false });

describe('workspace history cache lifetime', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps only the configured number of newest prompts after repeated submissions', async () => {
    let id = 0;
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) =>
      Response.json(
        init?.method === 'POST'
          ? { saved: true, prompt: { id: String(++id), text: 'prompt', submittedAt: id }, preview: { count: 2 } }
          : { prompts: [{ id: 'seed', text: 'seed', submittedAt: 0 }] },
      ),
    );
    vi.stubGlobal('fetch', fetch);
    const state = createState();
    state.applyComposerHistorySettings({ enabled: true, limit: 2 });
    await state.loadWorkspaceComposerPrompts('workspace');
    for (let index = 0; index < 20; index++) await state.recordWorkspaceComposerPrompt('workspace', 'prompt');
    expect((await state.loadWorkspaceComposerPrompts('workspace')).map((prompt) => prompt.id)).toEqual(['20', '19']);
    expect(fetch).toHaveBeenCalledTimes(21);
    state.dispose();
  });

  it('does not repopulate an invalidated cache from a late response', async () => {
    let resolve!: (response: Response) => void;
    const fetch = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((done) => {
            resolve = done;
          }),
      )
      .mockResolvedValue(Response.json({ prompts: [] }));
    vi.stubGlobal('fetch', fetch);
    const state = createState();
    state.applyComposerHistorySettings({ enabled: true, limit: 2 });
    const pending = state.loadWorkspaceComposerPrompts('workspace');
    state.dispose();
    resolve(Response.json({ prompts: [{ id: 'old', text: 'old', submittedAt: 0 }] }));
    await pending;
    expect(await state.loadWorkspaceComposerPrompts('workspace')).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(2);
    state.dispose();
  });
});
