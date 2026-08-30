import { error, json, type RequestHandler } from '@sveltejs/kit';
import { requireAuthentication } from '~/lib/features/auth/server/auth.server.ts';
import { deleteRepositoryBranch, RepositoryReadError } from '~/lib/features/repository/server/repository.server.ts';
import { findWorkspaceDirectory } from '~/lib/app/server/workspace-registry.server.ts';

function repositoryErrorStatus(reason: string): number {
  if (reason === 'invalid-path') return 400;
  if (reason === 'not-found') return 404;
  if (reason === 'not-git' || reason === 'conflict') return 409;
  return 503;
}

export const DELETE: RequestHandler = async (event) => {
  requireAuthentication(event);
  const id = event.params.id;
  if (!id) throw error(400, 'Workspace ID is required.');
  const name = event.url.searchParams.get('path');
  if (!name) throw error(400, 'Branch name is required.');

  const workspace = await findWorkspaceDirectory(id);
  if (!workspace) throw error(404, 'Workspace was not found.');
  try {
    return json(await deleteRepositoryBranch(workspace.cwd, name));
  } catch (cause) {
    if (cause instanceof RepositoryReadError) throw error(repositoryErrorStatus(cause.reason), cause.message);
    throw error(500, 'Vampire could not delete this branch.');
  }
};
