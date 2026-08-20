import { error, json, type RequestHandler } from '@sveltejs/kit';
import { requireAuthentication } from '$lib/server/auth';
import {
	SessionMutationError,
	updateManagedStartupProfile,
	updateManagedWorkspaceStartup
} from '$lib/server/session-registry';
import { isLaunchProfileList } from '$lib/session/launch-profiles';

export const PUT: RequestHandler = async (event) => {
	requireAuthentication(event);
	const id = event.params.id;
	if (!id) throw error(400, 'Session ID is required.');

	const body: unknown = await event.request.json().catch(() => undefined);
	if (!body || typeof body !== 'object' || Array.isArray(body) || !('startupProfileId' in body)) {
		throw error(400, 'A startup profile is required.');
	}
	const startupProfileId = body.startupProfileId;
	if (startupProfileId !== null && typeof startupProfileId !== 'string') {
		throw error(400, 'The startup profile must be a profile ID or null.');
	}
	const launchProfiles = 'launchProfiles' in body ? body.launchProfiles : undefined;
	if (launchProfiles !== undefined && !isLaunchProfileList(launchProfiles)) {
		throw error(400, 'Launch profiles must contain valid names and single-line commands.');
	}

	try {
		if (launchProfiles !== undefined) {
			return json(await updateManagedWorkspaceStartup(id, {
				launchProfiles,
				startupProfileId
			}));
		}
		return json({ startupProfileId: await updateManagedStartupProfile(id, startupProfileId) });
	} catch (cause) {
		if (cause instanceof SessionMutationError) {
			throw error(cause.reason === 'not-found' ? 404 : 400, cause.message);
		}
		throw error(500, 'Vampire could not save the startup profile.');
	}
};
