import { error, json, type RequestHandler } from '@sveltejs/kit';
import { requireAuthentication } from '~/lib/features/auth/server/auth';
import { GitWorktreeError } from '~/lib/features/repository/server/git-worktree';
import {
  createManagedWorktreeWorkspace,
  WorkspaceLaunchError,
  WorkspaceMutationError,
} from '~/lib/features/workspace/server/workspace-registry';

export const POST: RequestHandler = async (event) => {
  requireAuthentication(event);
  const sourceWorkspaceId = event.params.id;
  if (!sourceWorkspaceId) throw error(400, 'Source workspace ID is required.');
  const body: unknown = await event.request.json().catch(() => undefined);
  const name = body && typeof body === 'object' && !Array.isArray(body) && 'name' in body ? body.name : undefined;
  if (typeof name !== 'string') throw error(400, 'Task name is required.');

  try {
    const workspace = await createManagedWorktreeWorkspace({ sourceWorkspaceId, name });
    return json({ workspace }, { status: 201 });
  } catch (cause) {
    if (cause instanceof WorkspaceMutationError) {
      throw error(cause.reason === 'not-found' ? 404 : 409, cause.message);
    }
    if (cause instanceof GitWorktreeError) {
      const status = cause.reason === 'command-failed' || cause.reason === 'invalid-location' ? 500 : 400;
      throw error(status, cause.message);
    }
    if (cause instanceof WorkspaceLaunchError) throw error(500, cause.message);
    throw error(500, 'Vampire could not create the isolated workspace.');
  }
};
