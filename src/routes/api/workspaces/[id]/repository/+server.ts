import { findWorkspaceDirectory } from '~/lib/app/server/workspace-registry.server.ts';
import { requireAuthentication } from '~/lib/features/auth/server/auth.server.ts';
import { RepositoryReadError, readRepositorySnapshot } from '~/lib/features/repository/server/repository.server.ts';
import { error, json, type RequestHandler } from '~/lib/server/http-handler.server.ts';

export const GET: RequestHandler = async (event) => {
  requireAuthentication(event);
  const id = event.params.id;
  if (!id) throw error(400, 'Workspace ID is required.');

  const workspace = await findWorkspaceDirectory(id);
  if (!workspace) throw error(404, 'Workspace was not found.');

  try {
    const commitLimit = Number(event.url.searchParams.get('commitLimit') ?? 20);
    return json(await readRepositorySnapshot(workspace.cwd, commitLimit));
  } catch (cause) {
    if (cause instanceof RepositoryReadError) {
      if (cause.reason === 'not-found') throw error(404, cause.message);
      if (cause.reason === 'too-large') throw error(413, cause.message);
      throw error(503, cause.message);
    }
    throw error(500, 'Vampire could not read this workspace.');
  }
};
