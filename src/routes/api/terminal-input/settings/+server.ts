import { error, json, type RequestHandler } from '@sveltejs/kit';
import { requireAuthentication } from '~/lib/features/auth/server/auth.server.ts';
import {
  readManagedTerminalInputSettings,
  TerminalInputSettingsError,
  updateManagedTerminalInputSettings,
} from '~/lib/features/terminal/server/terminal-input-settings.server.ts';

export const GET: RequestHandler = async (event) => {
  requireAuthentication(event);
  try {
    return json(await readManagedTerminalInputSettings(), { headers: { 'cache-control': 'no-store' } });
  } catch {
    throw error(500, 'Vampire could not load terminal input settings.');
  }
};

export const PUT: RequestHandler = async (event) => {
  requireAuthentication(event);
  const body: unknown = await event.request.json().catch(() => undefined);
  try {
    return json(await updateManagedTerminalInputSettings(body));
  } catch (cause) {
    if (cause instanceof TerminalInputSettingsError) throw error(400, cause.message);
    throw error(500, 'Vampire could not save terminal input settings.');
  }
};
