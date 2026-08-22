import { error, json, type RequestHandler } from '@sveltejs/kit';
import { requireAuthentication } from '~/lib/features/auth/server/auth';
import { closeManagedWorkspace, WorkspaceMutationError } from '~/lib/app/server/workspace-registry';

export const POST: RequestHandler = async (event) => {
  requireAuthentication(event);
  const id = event.params.id;
  if (!id) throw error(400, 'Workspace ID is required.');
  try {
    await closeManagedWorkspace(id);
    return json({ ok: true });
  } catch (cause) {
    if (cause instanceof WorkspaceMutationError) throw error(404, cause.message);
    throw error(500, 'Vampire could not close the workspace.');
  }
};
