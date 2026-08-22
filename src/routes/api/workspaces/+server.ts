import { error, json, type RequestHandler } from '@sveltejs/kit';
import { requireAuthentication } from '~/lib/features/auth/server/auth';
import {
  createManagedWorkspace,
  listManagedWorkspaces,
  readManagedLaunchProfiles,
  readManagedWorkspacePreferences,
  WorkspaceLaunchError,
} from '~/lib/app/server/workspace-registry';

export const GET: RequestHandler = async (event) => {
  requireAuthentication(event);
  const [workspaces, preferences, launchProfiles] = await Promise.all([
    listManagedWorkspaces(),
    readManagedWorkspacePreferences(),
    readManagedLaunchProfiles(),
  ]);
  return json({ workspaces, preferences, launchProfiles }, { headers: { 'cache-control': 'no-store' } });
};

export const POST: RequestHandler = async (event) => {
  requireAuthentication(event);
  const body: unknown = await event.request.json().catch(() => undefined);
  const cwd = body && typeof body === 'object' && !Array.isArray(body) && 'cwd' in body ? body.cwd : undefined;
  if (typeof cwd !== 'string') throw error(400, 'Working directory is required.');

  try {
    const workspace = await createManagedWorkspace({ cwd });
    return json({ workspace }, { status: 201 });
  } catch (cause) {
    if (cause instanceof WorkspaceLaunchError) {
      const status = cause.reason === 'invalid-cwd' ? 400 : 500;
      throw error(status, cause.message);
    }
    throw error(500, 'Vampire could not create the workspace.');
  }
};
