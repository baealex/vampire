import { error, json, type RequestHandler } from '@sveltejs/kit';
import { requireAuthentication } from '~/lib/features/auth/server/auth.server.ts';
import {
  createManagedKingWorkspace,
  WorkspaceLaunchError,
  WorkspaceMutationError,
} from '~/lib/app/server/workspace-registry.server.ts';

export const POST: RequestHandler = async (event) => {
  requireAuthentication(event);
  const body: unknown = await event.request.json().catch(() => undefined);
  const launchProfileId =
    body && typeof body === 'object' && !Array.isArray(body) && 'launchProfileId' in body ? body.launchProfileId : null;
  if (launchProfileId !== null && typeof launchProfileId !== 'string') {
    throw error(400, 'Launch profile must be a string or null.');
  }

  try {
    const workspace = await createManagedKingWorkspace({ launchProfileId });
    return json({ workspace }, { status: 201 });
  } catch (cause) {
    if (cause instanceof WorkspaceMutationError) {
      const status = cause.reason === 'king-already-exists' ? 409 : 400;
      throw error(status, cause.message);
    }
    if (cause instanceof WorkspaceLaunchError) throw error(500, cause.message);
    throw error(500, 'Vampire could not create the King workspace.');
  }
};
