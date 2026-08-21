import { error, json, type RequestHandler } from '@sveltejs/kit';
import { requireAuthentication } from '$lib/server/auth';
import {
	queueManagedSessionNoteSummary,
	SessionAutomationMutationError
} from '$lib/server/session-automations';

export const POST: RequestHandler = async (event) => {
	requireAuthentication(event);
	const id = event.params.id;
	if (!id) throw error(400, 'Session ID is required.');
	try {
		const { automation, notePath } = await queueManagedSessionNoteSummary(id);
		return json({ automation, notePath }, { status: 202 });
	} catch (cause) {
		if (cause instanceof SessionAutomationMutationError) {
			throw error(cause.reason === 'not-found' ? 404 : cause.reason === 'limit' ? 409 : 400, cause.message);
		}
		throw error(500, 'Vampire could not queue the workspace note update.');
	}
};
