import { error, json, type RequestHandler } from '@sveltejs/kit';
import { requireAuthentication } from '$lib/server/auth';
import {
	removeManagedSession,
	restartManagedSession,
	SessionLaunchError,
	SessionMutationError,
	stopAndRemoveManagedSession,
	touchManagedSession
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

export const POST: RequestHandler = async (event) => {
	requireAuthentication(event);
	const id = event.params.id;
	if (!id) throw error(400, 'Session ID is required.');
	try {
		return json({ session: await restartManagedSession(id) });
	} catch (cause) {
		if (cause instanceof SessionMutationError) {
			throw error(cause.reason === 'not-found' ? 404 : 409, cause.message);
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
