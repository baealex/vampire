import { error, json, type RequestHandler } from '@sveltejs/kit';
import { requireAuthentication } from '$lib/server/auth';
import {
	readManagedLaunchProfiles,
	SessionMutationError,
	updateManagedLaunchProfiles
} from '$lib/server/session-registry';
import { isLaunchProfileList } from '$lib/session/launch-profiles';

export const GET: RequestHandler = async (event) => {
	requireAuthentication(event);
	return json(
		{ launchProfiles: await readManagedLaunchProfiles() },
		{ headers: { 'cache-control': 'no-store' } }
	);
};

export const PUT: RequestHandler = async (event) => {
	requireAuthentication(event);
	const body: unknown = await event.request.json().catch(() => undefined);
	const launchProfiles = body && typeof body === 'object' && !Array.isArray(body) && 'launchProfiles' in body
		? body.launchProfiles
		: undefined;
	if (!isLaunchProfileList(launchProfiles)) {
		throw error(400, 'Launch profiles must contain valid names and single-line commands.');
	}

	try {
		return json(await updateManagedLaunchProfiles(launchProfiles));
	} catch (cause) {
		if (cause instanceof SessionMutationError) throw error(400, cause.message);
		throw error(500, 'Vampire could not save the launch profiles.');
	}
};
