import { error, json, type RequestHandler } from '@sveltejs/kit';
import { requireAuthentication } from '~/lib/features/auth/server/auth.server.ts';
import {
  readManagedWorkspacePreferences,
  WorkspaceMutationError,
  updateManagedWorkspacePreferences,
} from '~/lib/app/server/workspace-registry.server.ts';

export const GET: RequestHandler = async (event) => {
  requireAuthentication(event);
  return json({ preferences: await readManagedWorkspacePreferences() }, { headers: { 'cache-control': 'no-store' } });
};

export const PUT: RequestHandler = async (event) => {
  requireAuthentication(event);
  const body: unknown = await event.request.json().catch(() => undefined);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw error(400, 'Workspace preferences are required.');
  }
  const { workspaceOrderMode, manualWorkspaceOrder } = body as Record<string, unknown>;
  if (
    (workspaceOrderMode !== 'activity' && workspaceOrderMode !== 'manual') ||
    !Array.isArray(manualWorkspaceOrder) ||
    !manualWorkspaceOrder.every((id) => typeof id === 'string')
  ) {
    throw error(400, 'Workspace order preferences are invalid.');
  }

  try {
    return json({
      preferences: await updateManagedWorkspacePreferences({
        workspaceOrderMode,
        manualWorkspaceOrder,
      }),
    });
  } catch (cause) {
    if (cause instanceof WorkspaceMutationError && cause.reason === 'invalid-workspace-preferences') {
      throw error(400, cause.message);
    }
    throw error(500, 'Vampire could not save workspace preferences.');
  }
};
