import { error, json, type RequestHandler } from '@sveltejs/kit';
import { requireAuthentication } from '$lib/server/auth';
import {
	findManagedSession,
	SessionMutationError,
	updateManagedLaunchProfiles,
	type LaunchProfileSettings
} from '$lib/server/session-registry';
import { isLaunchProfileList } from '$lib/session/launch-profiles';

export const GET: RequestHandler = async (event) => {
	requireAuthentication(event);
	const id = event.params.id;
	if (!id) throw error(400, 'Session ID is required.');
	const session = await findManagedSession(id);
	if (!session) throw error(404, 'Session was not found.');
	return json({
		launchProfiles: session.launchProfiles,
		defaultLaunchProfileId: session.defaultLaunchProfileId,
		autoStartDefaultProfile: session.autoStartDefaultProfile
	}, { headers: { 'cache-control': 'no-store' } });
};

export const PUT: RequestHandler = async (event) => {
	requireAuthentication(event);
	const id = event.params.id;
	if (!id) throw error(400, 'Session ID is required.');

	const body: unknown = await event.request.json().catch(() => undefined);
	if (!body || typeof body !== 'object' || Array.isArray(body)) {
		throw error(400, 'A JSON body is required.');
	}
	const value = body as Record<string, unknown>;
	const defaultLaunchProfileId = value.defaultLaunchProfileId === null ? null : value.defaultLaunchProfileId;
	if (!isLaunchProfileList(value.launchProfiles)
		|| (defaultLaunchProfileId !== null && typeof defaultLaunchProfileId !== 'string')) {
		throw error(400, 'Launch profiles must contain valid names and single-line commands.');
	}
	const settings: LaunchProfileSettings = {
		launchProfiles: value.launchProfiles,
		defaultLaunchProfileId,
		autoStartDefaultProfile: value.autoStartDefaultProfile === true
	};

	try {
		return json(await updateManagedLaunchProfiles(id, settings));
	} catch (cause) {
		if (cause instanceof SessionMutationError) {
			throw error(cause.reason === 'not-found' ? 404 : 400, cause.message);
		}
		throw error(500, 'Vampire could not save the launch profiles.');
	}
};
