import { error, json, type RequestHandler } from '@sveltejs/kit';
import { requireAuthentication } from '$lib/server/auth';
import { captureManagedBackgroundOutput, SessionMutationError } from '$lib/server/session-registry';

export const GET: RequestHandler = async (event) => {
	requireAuthentication(event);
	const id = event.params.id;
	const processId = event.params.processId;
	if (!id) throw error(400, 'Session ID is required.');
	if (!processId || !/^@\d+$/.test(processId)) throw error(400, 'Background process ID is invalid.');

	try {
		return json(
			{ output: await captureManagedBackgroundOutput(id, processId) },
			{ headers: { 'cache-control': 'no-store' } }
		);
	} catch (cause) {
		if (cause instanceof SessionMutationError) {
			throw error(['not-found', 'background-not-found'].includes(cause.reason) ? 404 : 409, cause.message);
		}
		throw error(500, 'Vampire could not read the background output.');
	}
};
