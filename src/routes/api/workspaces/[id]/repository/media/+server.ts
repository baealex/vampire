import { error, type RequestHandler } from '@sveltejs/kit';
import { requireAuthentication } from '~/lib/features/auth/server/auth';
import {
  readWorkspaceImage,
  readWorkspaceImageMetadata,
  RepositoryReadError,
} from '~/lib/features/repository/server/repository.ts';
import { findWorkspaceDirectory } from '~/lib/features/workspace/server/workspace-registry';

function repositoryErrorStatus(reason: string): number {
  if (reason === 'invalid-path') return 400;
  if (reason === 'not-found') return 404;
  if (reason === 'too-large') return 413;
  if (reason === 'unsupported-file') return 415;
  return 503;
}

async function requestDetails(event: Parameters<RequestHandler>[0]) {
  requireAuthentication(event);
  const id = event.params.id;
  if (!id) throw error(400, 'Workspace ID is required.');
  const path = event.url.searchParams.get('path');
  if (!path) throw error(400, 'File path is required.');
  const workspace = await findWorkspaceDirectory(id);
  if (!workspace) throw error(404, 'Workspace was not found.');
  return { cwd: workspace.cwd, path };
}

export const HEAD: RequestHandler = async (event) => {
  const { cwd, path } = await requestDetails(event);
  try {
    const image = await readWorkspaceImageMetadata(cwd, path);
    return new Response(null, {
      headers: {
        'content-length': String(image.size),
        'content-type': image.mimeType,
        etag: `W/"${image.version}"`,
      },
    });
  } catch (cause) {
    if (cause instanceof RepositoryReadError) throw error(repositoryErrorStatus(cause.reason), cause.message);
    throw error(500, 'Vampire could not inspect this image.');
  }
};

export const GET: RequestHandler = async (event) => {
  const { cwd, path } = await requestDetails(event);
  try {
    const image = await readWorkspaceImage(cwd, path);
    return new Response(new Uint8Array(image.bytes), {
      headers: {
        'content-length': String(image.size),
        'content-type': image.mimeType,
        'content-disposition': 'inline',
        etag: `W/"${image.version}"`,
      },
    });
  } catch (cause) {
    if (cause instanceof RepositoryReadError) throw error(repositoryErrorStatus(cause.reason), cause.message);
    throw error(500, 'Vampire could not read this image.');
  }
};
