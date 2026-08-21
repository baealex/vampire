import { error, json, type RequestHandler } from '@sveltejs/kit';
import { requireAuthentication } from '$lib/server/auth';
import {
  removeManagedSession,
  restartManagedSession,
  SessionLaunchError,
  SessionMutationError,
  stopAndRemoveManagedSession,
  touchManagedSession,
} from '$lib/server/session-registry';

export const PATCH: RequestHandler = async (event) => {
  requireAuthentication(event);
  const id = event.params.id;
  if (!id) throw error(400, 'Session ID is required.');
  try {
    return json({ lastActiveAt: await touchManagedSession(id) });
  } catch (cause) {
    if (cause instanceof SessionMutationError) throw error(404, cause.message);
    throw error(500, 'Vampire could not update the session activity.');
  }
};

async function readRestartLaunchProfileId(request: Request): Promise<string | null | undefined> {
  const text = await request.text();
  if (!text.trim()) return undefined;

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw error(400, 'Restart data must be valid JSON.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) || !('launchProfileId' in body)) {
    throw error(400, 'A launch profile ID or null is required.');
  }
  const launchProfileId = body.launchProfileId;
  if (launchProfileId !== null && typeof launchProfileId !== 'string') {
    throw error(400, 'The launch profile must be a profile ID or null.');
  }
  return launchProfileId;
}

export const POST: RequestHandler = async (event) => {
  requireAuthentication(event);
  const id = event.params.id;
  if (!id) throw error(400, 'Session ID is required.');
  const launchProfileId = await readRestartLaunchProfileId(event.request);
  try {
    return json({ session: await restartManagedSession(id, { launchProfileId }) });
  } catch (cause) {
    if (cause instanceof SessionMutationError) {
      throw error(
        cause.reason === 'not-found' ? 404 : cause.reason === 'invalid-startup-profile' ? 400 : 409,
        cause.message
      );
    }
    if (cause instanceof SessionLaunchError) {
      throw error(cause.reason === 'invalid-cwd' ? 400 : 500, cause.message);
    }
    throw error(500, 'Vampire could not restart the session.');
  }
};

export const DELETE: RequestHandler = async (event) => {
  requireAuthentication(event);
  const id = event.params.id;
  if (!id) throw error(400, 'Session ID is required.');
  try {
    if (event.url.searchParams.get('terminate') === 'true') await stopAndRemoveManagedSession(id);
    else await removeManagedSession(id);
    return json({ ok: true });
  } catch (cause) {
    if (cause instanceof SessionMutationError) {
      throw error(cause.reason === 'not-found' ? 404 : 409, cause.message);
    }
    throw error(500, 'Vampire could not remove the session.');
  }
};
