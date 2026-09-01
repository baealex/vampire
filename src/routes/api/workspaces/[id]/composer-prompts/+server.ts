import { error, json, type RequestHandler } from '@sveltejs/kit';
import { requireAuthentication } from '~/lib/features/auth/server/auth.server.ts';
import {
  appendManagedWorkspaceComposerPrompt,
  listManagedWorkspaceComposerPrompts,
  WorkspaceComposerHistoryError,
} from '~/lib/features/workspace/server/workspace-composer-history.server.ts';

function composerHistoryError(cause: WorkspaceComposerHistoryError): never {
  throw error(cause.reason === 'not-found' ? 404 : 400, cause.message);
}

export const GET: RequestHandler = async (event) => {
  requireAuthentication(event);
  const id = event.params.id;
  if (!id) throw error(400, 'Workspace ID is required.');
  try {
    return json(
      { prompts: await listManagedWorkspaceComposerPrompts(id) },
      { headers: { 'cache-control': 'no-store' } }
    );
  } catch (cause) {
    if (cause instanceof WorkspaceComposerHistoryError) composerHistoryError(cause);
    throw error(500, 'Vampire could not load Composer history.');
  }
};

export const POST: RequestHandler = async (event) => {
  requireAuthentication(event);
  const id = event.params.id;
  if (!id) throw error(400, 'Workspace ID is required.');
  const body: unknown = await event.request.json().catch(() => undefined);
  const prompt =
    body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>).prompt : undefined;
  try {
    return json(await appendManagedWorkspaceComposerPrompt(id, prompt), { status: 201 });
  } catch (cause) {
    if (cause instanceof WorkspaceComposerHistoryError) composerHistoryError(cause);
    throw error(500, 'Vampire could not save this Composer prompt.');
  }
};
