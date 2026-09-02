import { expect, test, vi } from 'vitest';
import { TerminalInputPreferences } from './input-preferences.svelte.ts';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

test('loads terminal input preferences from the server', async () => {
  const fetchMock = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(jsonResponse({ mode: 'compose', slashHandoff: false }));
  const preferences = new TerminalInputPreferences();

  await preferences.refresh();

  expect(fetchMock).toHaveBeenCalledWith('/api/terminal-input/settings', undefined);
  expect(preferences.settings).toEqual({ mode: 'compose', slashHandoff: false });
  expect(preferences.loaded).toBe(true);
  expect(preferences.loadError).toBe('');
});

test('does not let an older load overwrite a saved server preference', async () => {
  let finishLoad: (response: Response) => void = () => undefined;
  const pendingLoad = new Promise<Response>((resolve) => {
    finishLoad = resolve;
  });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    if (init?.method === 'PUT') return jsonResponse({ mode: 'compose', slashHandoff: false });
    return pendingLoad;
  });
  const preferences = new TerminalInputPreferences();

  const loading = preferences.refresh();
  await preferences.update({ mode: 'compose', slashHandoff: false });
  finishLoad(jsonResponse({ mode: 'terminal', slashHandoff: true }));
  await loading;

  expect(preferences.settings).toEqual({ mode: 'compose', slashHandoff: false });
});

test('reports an initial load failure without marking defaults as server settings', async () => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Server is unavailable'));
  const preferences = new TerminalInputPreferences();

  await preferences.refresh();

  expect(preferences.loaded).toBe(false);
  expect(preferences.loadError).toBe('Server is unavailable');
});
