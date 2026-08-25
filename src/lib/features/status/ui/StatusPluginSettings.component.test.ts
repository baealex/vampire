import { render, screen, waitFor } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { queryCache } from '~/lib/shared/api/query-cache.ts';
import type { StatusPlugin } from '~/lib/shared/contracts/status-plugin.ts';
import StatusPluginSettings from './StatusPluginSettings.svelte';

const STATUS_PLUGINS_QUERY = 'status/plugins';

function plugin(name: string, command = 'echo ready'): StatusPlugin {
  return {
    id: 'plugin-1',
    name,
    enabled: true,
    intervalMs: 60_000,
    source: { type: 'command', command },
  };
}

afterEach(() => queryCache.clear());

test('does not replace an unsaved widget draft with a background refresh', async () => {
  const user = userEvent.setup();
  const initial = { plugins: [plugin('Original widget')], presets: [] };
  queryCache.set(STATUS_PLUGINS_QUERY, initial);
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () =>
      new Response(JSON.stringify(initial), {
        headers: { 'content-type': 'application/json' },
      })
  );
  render(StatusPluginSettings, { close: vi.fn() });

  await waitFor(() => expect(document.querySelector('.status-settings')).toHaveAttribute('aria-busy', 'false'));
  await user.click(screen.getByRole('button', { name: 'Edit Original widget' }));
  const name = screen.getByRole('textbox', { name: 'Name' });
  await user.clear(name);
  await user.type(name, 'Local widget draft');

  queryCache.set(STATUS_PLUGINS_QUERY, {
    plugins: [plugin('Updated on another tab', 'echo external')],
    presets: [],
  });

  expect(name).toHaveValue('Local widget draft');
  expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
});
