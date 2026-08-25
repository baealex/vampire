import { error, json, type RequestHandler } from '@sveltejs/kit';
import { requireAuthentication } from '~/lib/features/auth/server/auth';
import {
  queueManagedWorkspaceNoteUpdate,
  WorkspaceAutomationMutationError,
} from '~/lib/features/workspace/server/workspace-automations';

export const POST: RequestHandler = async (event) => {
  requireAuthentication(event);
  const id = event.params.id;
  if (!id) throw error(400, 'Workspace ID is required.');

  let body: unknown;
  try {
    body = await event.request.json();
  } catch {
    throw error(400, 'A JSON body is required.');
  }
  const instructions =
    body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>).instructions
      : undefined;

  try {
    const { automation, notePath } = await queueManagedWorkspaceNoteUpdate(id, instructions);
    return json({ automation, notePath }, { status: 202 });
  } catch (cause) {
    if (cause instanceof WorkspaceAutomationMutationError) {
      throw error(cause.reason === 'not-found' ? 404 : cause.reason === 'limit' ? 409 : 400, cause.message);
    }
    throw error(500, 'Vampire could not queue the workspace note update.');
  }
};
