import { error, json, type RequestHandler } from '@sveltejs/kit';
import { requireAuthentication } from '$lib/server/auth';
import { closeManagedSession, SessionMutationError } from '$lib/server/session-registry';

export const POST: RequestHandler = async (event) => {
	requireAuthentication(event);
	const id = event.params.id;
	if (!id) throw error(400, 'Session ID is required.');
	try {
		await closeManagedSession(id);
		return json({ ok: true });
	} catch (cause) {
		if (cause instanceof SessionMutationError) throw error(404, cause.message);
		throw error(500, 'Vampire could not close the session.');
	}
};
