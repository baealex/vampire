import { error, json, type RequestHandler } from '@sveltejs/kit';
import { requireAuthentication } from '~/lib/features/auth/server/auth.server.ts';
import {
  readManagedLaunchProfileSettings,
  WorkspaceMutationError,
  updateManagedLaunchProfiles,
} from '~/lib/app/server/workspace-registry.server.ts';
import { isLaunchProfileList } from '~/lib/shared/contracts/launch-profiles';

export const GET: RequestHandler = async (event) => {
  requireAuthentication(event);
  return json(await readManagedLaunchProfileSettings(), { headers: { 'cache-control': 'no-store' } });
};

export const PUT: RequestHandler = async (event) => {
  requireAuthentication(event);
  const body: unknown = await event.request.json().catch(() => undefined);
  const record = body && typeof body === 'object' && !Array.isArray(body) ? body : undefined;
  const launchProfiles = record && 'launchProfiles' in record ? record.launchProfiles : undefined;
  if (!isLaunchProfileList(launchProfiles)) {
    throw error(400, 'Launch profiles must contain valid names and single-line commands.');
  }
  const defaultStartupProfileId =
    record && 'defaultStartupProfileId' in record ? record.defaultStartupProfileId : undefined;
  if (
    defaultStartupProfileId !== undefined &&
    defaultStartupProfileId !== null &&
    typeof defaultStartupProfileId !== 'string'
  ) {
    throw error(400, 'The default startup profile must be a profile ID or null.');
  }
  const applyDefaultToAll = record && 'applyDefaultToAll' in record ? record.applyDefaultToAll : false;
  if (typeof applyDefaultToAll !== 'boolean') {
    throw error(400, 'The apply-to-all option must be a boolean.');
  }

  try {
    return json(
      await updateManagedLaunchProfiles(launchProfiles, {
        ...(defaultStartupProfileId !== undefined ? { defaultStartupProfileId } : {}),
        applyDefaultToAll,
      })
    );
  } catch (cause) {
    if (cause instanceof WorkspaceMutationError) throw error(400, cause.message);
    throw error(500, 'Vampire could not save the launch profiles.');
  }
};
