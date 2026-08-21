import { error, json, type RequestHandler } from '@sveltejs/kit';
import { requireAuthentication } from '~/lib/features/auth/server/auth';
import {
  queueManagedWorkspaceNoteSummary,
  WorkspaceAutomationMutationError,
} from '~/lib/features/workspace/server/workspace-automations';

export const POST: RequestHandler = async (event) => {
  requireAuthentication(event);
  const id = event.params.id;
  if (!id) throw error(400, 'Workspace ID is required.');
  try {
    const { automation, notePath } = await queueManagedWorkspaceNoteSummary(id);
    return json({ automation, notePath }, { status: 202 });
  } catch (cause) {
    if (cause instanceof WorkspaceAutomationMutationError) {
      throw error(cause.reason === 'not-found' ? 404 : cause.reason === 'limit' ? 409 : 400, cause.message);
    }
    throw error(500, 'Vampire could not queue the workspace note update.');
  }
};
