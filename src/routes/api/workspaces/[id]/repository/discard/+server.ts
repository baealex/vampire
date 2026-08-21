import { error, json, type RequestHandler } from '@sveltejs/kit';
import { requireAuthentication } from '~/lib/features/auth/server/auth';
import { discardRepositoryChange, RepositoryReadError } from '~/lib/features/repository/server/repository.ts';
import { findWorkspaceDirectory } from '~/lib/features/workspace/server/workspace-registry';
import type { RepositoryChange } from '~/lib/shared/contracts/repository';

function repositoryErrorStatus(reason: string): number {
  if (reason === 'conflict') return 409;
  if (reason === 'invalid-path') return 400;
  if (reason === 'not-found') return 404;
  if (reason === 'not-git') return 409;
  return 503;
}

export const POST: RequestHandler = async (event) => {
  requireAuthentication(event);
  const id = event.params.id;
  if (!id) throw error(400, 'Workspace ID is required.');

  let body: unknown;
  try {
    body = await event.request.json();
  } catch {
    throw error(400, 'Discard data is invalid.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw error(400, 'Discard data is invalid.');
  const value = body as Record<string, unknown>;
  if (typeof value.path !== 'string' || !value.path) throw error(400, 'Changed path is required.');
  if (typeof value.status !== 'string' || value.status.length !== 2) throw error(400, 'Git status is invalid.');
  if (value.previousPath !== undefined && typeof value.previousPath !== 'string') {
    throw error(400, 'Previous path is invalid.');
  }

  const workspace = await findWorkspaceDirectory(id);
  if (!workspace) throw error(404, 'Workspace was not found.');
  const expected: RepositoryChange = {
    path: value.path,
    status: value.status,
    ...(typeof value.previousPath === 'string' ? { previousPath: value.previousPath } : {}),
  };
  try {
    return json(await discardRepositoryChange(workspace.cwd, value.path, expected));
  } catch (cause) {
    if (cause instanceof RepositoryReadError) throw error(repositoryErrorStatus(cause.reason), cause.message);
    throw error(500, 'Vampire could not discard this change.');
  }
};
