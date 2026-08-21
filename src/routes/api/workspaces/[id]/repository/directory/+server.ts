import { error, json, type RequestHandler } from '@sveltejs/kit';
import { requireAuthentication } from '~/lib/features/auth/server/auth';
import {
  createWorkspaceDirectory,
  deleteWorkspaceEntry,
  readRepositoryDirectory,
  RepositoryReadError,
} from '~/lib/features/repository/server/repository.ts';
import { findWorkspaceDirectory } from '~/lib/features/workspace/server/workspace-registry';

function repositoryErrorStatus(reason: string): number {
  if (reason === 'conflict') return 409;
  if (reason === 'invalid-path') return 400;
  if (reason === 'not-found') return 404;
  if (reason === 'too-large') return 413;
  if (reason === 'unsupported-file') return 415;
  return 503;
}

export const GET: RequestHandler = async (event) => {
  requireAuthentication(event);
  const id = event.params.id;
  if (!id) throw error(400, 'Workspace ID is required.');

  const workspace = await findWorkspaceDirectory(id);
  if (!workspace) throw error(404, 'Workspace was not found.');

  try {
    return json(await readRepositoryDirectory(workspace.cwd, event.url.searchParams.get('path') ?? ''));
  } catch (cause) {
    if (cause instanceof RepositoryReadError) throw error(repositoryErrorStatus(cause.reason), cause.message);
    throw error(500, 'Vampire could not read this folder.');
  }
};

export const POST: RequestHandler = async (event) => {
  requireAuthentication(event);
  const id = event.params.id;
  if (!id) throw error(400, 'Workspace ID is required.');

  let body: unknown;
  try {
    body = await event.request.json();
  } catch {
    throw error(400, 'Folder data is invalid.');
  }
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    !('path' in body) ||
    typeof body.path !== 'string' ||
    !body.path
  ) {
    throw error(400, 'Folder path is required.');
  }

  const workspace = await findWorkspaceDirectory(id);
  if (!workspace) throw error(404, 'Workspace was not found.');

  try {
    return json(await createWorkspaceDirectory(workspace.cwd, body.path), { status: 201 });
  } catch (cause) {
    if (cause instanceof RepositoryReadError) throw error(repositoryErrorStatus(cause.reason), cause.message);
    throw error(500, 'Vampire could not create this folder.');
  }
};

export const DELETE: RequestHandler = async (event) => {
  requireAuthentication(event);
  const id = event.params.id;
  if (!id) throw error(400, 'Workspace ID is required.');
  const path = event.url.searchParams.get('path');
  if (!path) throw error(400, 'Folder path is required.');

  const workspace = await findWorkspaceDirectory(id);
  if (!workspace) throw error(404, 'Workspace was not found.');

  try {
    return json(await deleteWorkspaceEntry(workspace.cwd, path, 'directory'));
  } catch (cause) {
    if (cause instanceof RepositoryReadError) throw error(repositoryErrorStatus(cause.reason), cause.message);
    throw error(500, 'Vampire could not delete this folder.');
  }
};
