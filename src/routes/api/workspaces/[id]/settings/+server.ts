import { error, json, type RequestHandler } from '@sveltejs/kit';
import { requireAuthentication } from '~/lib/features/auth/server/auth.server.ts';
import { updateManagedWorkspaceSettings, WorkspaceMutationError } from '~/lib/app/server/workspace-registry.server.ts';

export const PUT: RequestHandler = async (event) => {
  requireAuthentication(event);
  const id = event.params.id;
  if (!id) throw error(400, 'Workspace ID is required.');

  const body: unknown = await event.request.json().catch(() => undefined);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw error(400, 'Workspace settings are required.');
  }
  const { startupProfileId, composerTemplate } = body as Record<string, unknown>;
  if (startupProfileId !== null && typeof startupProfileId !== 'string') {
    throw error(400, 'The startup profile must be a profile ID or null.');
  }
  if (typeof composerTemplate !== 'string') {
    throw error(400, 'A Composer template is required.');
  }

  try {
    return json(await updateManagedWorkspaceSettings(id, { startupProfileId, composerTemplate }));
  } catch (cause) {
    if (cause instanceof WorkspaceMutationError) {
      throw error(cause.reason === 'not-found' ? 404 : 400, cause.message);
    }
    throw error(500, 'Vampire could not save the workspace settings.');
  }
};
