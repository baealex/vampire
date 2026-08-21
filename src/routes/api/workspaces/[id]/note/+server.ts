import { error, json, type RequestHandler } from '@sveltejs/kit';
import { requireAuthentication } from '~/lib/features/auth/server/auth';
import {
  findManagedWorkspaceNote,
  WorkspaceMutationError,
  updateManagedWorkspaceNote,
} from '~/lib/features/workspace/server/workspace-registry';
import {
  normalizeWorkspaceNote,
  workspaceNoteByteLength,
  WORKSPACE_NOTE_MAX_BYTES,
} from '~/lib/features/workspace/server/workspace-note';

export const GET: RequestHandler = async (event) => {
  requireAuthentication(event);
  const id = event.params.id;
  if (!id) throw error(400, 'Workspace ID is required.');

  const note = await findManagedWorkspaceNote(id);
  if (note === undefined) throw error(404, 'Workspace was not found.');
  return json({ note }, { headers: { 'cache-control': 'no-store' } });
};

export const PUT: RequestHandler = async (event) => {
  requireAuthentication(event);
  const id = event.params.id;
  if (!id) throw error(400, 'Workspace ID is required.');

  let body: unknown;
  try {
    body = await event.request.json();
  } catch {
    throw error(400, 'A JSON body is required.');
  }

  const note =
    body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>).note : undefined;
  if (typeof note !== 'string') throw error(400, 'Note must be a string.');
  const normalizedNote = normalizeWorkspaceNote(note);
  if (workspaceNoteByteLength(normalizedNote) > WORKSPACE_NOTE_MAX_BYTES) {
    throw error(413, 'Note must be 128 KB or smaller.');
  }

  try {
    return json({ notePreview: await updateManagedWorkspaceNote(id, note) });
  } catch (cause) {
    if (cause instanceof WorkspaceMutationError) throw error(404, cause.message);
    throw error(500, 'Vampire could not save the workspace note.');
  }
};
