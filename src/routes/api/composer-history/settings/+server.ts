import { error, json, type RequestHandler } from '@sveltejs/kit';
import { requireAuthentication } from '~/lib/features/auth/server/auth.server.ts';
import {
  readManagedWorkspaceComposerHistorySettings,
  updateManagedWorkspaceComposerHistorySettings,
  WorkspaceComposerHistoryError,
} from '~/lib/features/workspace/server/workspace-composer-history.server.ts';

export const GET: RequestHandler = async (event) => {
  requireAuthentication(event);
  try {
    return json(await readManagedWorkspaceComposerHistorySettings(), {
      headers: { 'cache-control': 'no-store' },
    });
  } catch {
    throw error(500, 'Vampire could not load Composer history settings.');
  }
};

export const PUT: RequestHandler = async (event) => {
  requireAuthentication(event);
  const body: unknown = await event.request.json().catch(() => undefined);
  try {
    return json(await updateManagedWorkspaceComposerHistorySettings(body));
  } catch (cause) {
    if (cause instanceof WorkspaceComposerHistoryError && cause.reason === 'invalid-settings') {
      throw error(400, cause.message);
    }
    throw error(500, 'Vampire could not save Composer history settings.');
  }
};
