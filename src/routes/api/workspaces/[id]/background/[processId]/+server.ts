import { error, json, type RequestHandler } from '@sveltejs/kit';
import { requireAuthentication } from '~/lib/features/auth/server/auth';
import {
  WorkspaceMutationError,
  stopManagedBackgroundProcess,
} from '~/lib/features/workspace/server/workspace-registry';

export const DELETE: RequestHandler = async (event) => {
  requireAuthentication(event);
  const id = event.params.id;
  const processId = event.params.processId;
  if (!id) throw error(400, 'Workspace ID is required.');
  if (!processId || !/^@\d+$/.test(processId)) throw error(400, 'Background process ID is invalid.');

  try {
    await stopManagedBackgroundProcess(id, processId);
    return json({ ok: true });
  } catch (cause) {
    if (cause instanceof WorkspaceMutationError) {
      throw error(['not-found', 'background-not-found'].includes(cause.reason) ? 404 : 409, cause.message);
    }
    throw error(500, 'Vampire could not stop the background process.');
  }
};
