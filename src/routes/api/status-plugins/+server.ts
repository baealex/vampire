import { error, json, type RequestHandler } from '@sveltejs/kit';
import { requireAuthentication } from '~/lib/features/auth/server/auth.server.ts';
import {
  readStatusPluginStore,
  replaceStatusPlugins,
} from '~/lib/features/status/server/status-plugin-store.server.ts';
import { isStatusPluginList, STATUS_PLUGIN_PRESETS } from '~/lib/shared/contracts/status-plugin';

export const GET: RequestHandler = async (event) => {
  requireAuthentication(event);
  try {
    const state = await readStatusPluginStore();
    return json(
      { plugins: state.plugins, presets: STATUS_PLUGIN_PRESETS },
      {
        headers: { 'cache-control': 'no-store' },
      }
    );
  } catch {
    throw error(500, 'Vampire could not load the status plugins.');
  }
};

export const PUT: RequestHandler = async (event) => {
  requireAuthentication(event);
  const body: unknown = await event.request.json().catch(() => undefined);
  const plugins =
    body && typeof body === 'object' && !Array.isArray(body) && 'plugins' in body ? body.plugins : undefined;
  if (!isStatusPluginList(plugins)) {
    throw error(400, 'Status plugins must contain valid names, intervals, and single-line commands.');
  }

  try {
    const state = await replaceStatusPlugins(plugins);
    return json({ plugins: state.plugins }, { headers: { 'cache-control': 'no-store' } });
  } catch {
    throw error(500, 'Vampire could not save the status plugins.');
  }
};
