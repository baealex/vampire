import { error, json, type RequestHandler } from '@sveltejs/kit';
import { requireAuthentication } from '$lib/server/auth';
import {
	readManagedWorkspacePreferences,
	SessionMutationError,
	updateManagedWorkspacePreferences
} from '$lib/server/session-registry';

export const GET: RequestHandler = async (event) => {
	requireAuthentication(event);
	return json(
		{ preferences: await readManagedWorkspacePreferences() },
		{ headers: { 'cache-control': 'no-store' } }
	);
};

export const PUT: RequestHandler = async (event) => {
	requireAuthentication(event);
	const body: unknown = await event.request.json().catch(() => undefined);
	if (!body || typeof body !== 'object' || Array.isArray(body)) {
		throw error(400, 'Workspace preferences are required.');
	}
	const { sessionOrderMode, manualSessionOrder } = body as Record<string, unknown>;
	if ((sessionOrderMode !== 'activity' && sessionOrderMode !== 'manual')
		|| !Array.isArray(manualSessionOrder)
		|| !manualSessionOrder.every((id) => typeof id === 'string')) {
		throw error(400, 'Workspace order preferences are invalid.');
	}

	try {
		return json({
			preferences: await updateManagedWorkspacePreferences({
				sessionOrderMode,
				manualSessionOrder
			})
		});
	} catch (cause) {
		if (cause instanceof SessionMutationError && cause.reason === 'invalid-workspace-preferences') {
			throw error(400, cause.message);
		}
		throw error(500, 'Vampire could not save workspace preferences.');
	}
};
