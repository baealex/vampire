import { error, json, type RequestHandler } from '@sveltejs/kit';
import { findWorkspaceDirectory } from '~/lib/app/server/workspace-registry.server.ts';
import { requireAuthentication } from '~/lib/features/auth/server/auth.server.ts';
import { copyWorkspaceEntry, RepositoryReadError } from '~/lib/features/repository/server/repository.server.ts';
import type { WorkspaceEntryKind, WorkspaceMoveConflict } from '~/lib/shared/contracts/repository.ts';

function repositoryErrorStatus(reason: string): number {
  if (reason === 'conflict') return 409;
  if (reason === 'invalid-path') return 400;
  if (reason === 'not-found') return 404;
  if (reason === 'unsupported-file') return 415;
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
    throw error(400, 'Copy data is invalid.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw error(400, 'Copy data is invalid.');
  const value = body as Record<string, unknown>;
  if (typeof value.path !== 'string' || !value.path) throw error(400, 'Entry path is required.');
  if (value.kind !== 'file' && value.kind !== 'directory') throw error(400, 'Entry kind is invalid.');
  if (typeof value.targetDirectory !== 'string') throw error(400, 'Target folder is required.');
  const conflict = value.conflict ?? 'reject';
  if (conflict !== 'reject' && conflict !== 'rename') throw error(400, 'Copy conflict policy is invalid.');

  const workspace = await findWorkspaceDirectory(id);
  if (!workspace) throw error(404, 'Workspace was not found.');
  try {
    return json(
      await copyWorkspaceEntry(workspace.cwd, value.path, value.kind as WorkspaceEntryKind, value.targetDirectory, {
        conflict: conflict as WorkspaceMoveConflict,
      })
    );
  } catch (cause) {
    if (cause instanceof RepositoryReadError) throw error(repositoryErrorStatus(cause.reason), cause.message);
    throw error(500, 'Vampire could not copy this entry.');
  }
};
