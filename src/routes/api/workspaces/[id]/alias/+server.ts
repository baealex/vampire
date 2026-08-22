import { error, json, type RequestHandler } from '@sveltejs/kit';
import { requireAuthentication } from '~/lib/features/auth/server/auth';
import { WorkspaceMutationError, updateManagedWorkspaceAlias } from '~/lib/app/server/workspace-registry';

export const PUT: RequestHandler = async (event) => {
  requireAuthentication(event);
  const id = event.params.id;
  if (!id) throw error(400, 'Workspace ID is required.');

  const body: unknown = await event.request.json().catch(() => undefined);
  const alias =
    body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>).alias : undefined;
  if (typeof alias !== 'string') throw error(400, 'Workspace alias must be a string.');

  try {
    const workspaceLabel = await updateManagedWorkspaceAlias(id, alias);
    return json({ alias: workspaceLabel || null });
  } catch (cause) {
    if (cause instanceof WorkspaceMutationError) {
      if (cause.reason === 'not-found') throw error(404, cause.message);
      if (cause.reason === 'invalid-workspace-alias') throw error(400, cause.message);
    }
    throw error(500, 'Vampire could not save the workspace alias.');
  }
};
