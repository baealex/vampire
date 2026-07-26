import { error, json, type RequestHandler } from '@sveltejs/kit';
import { requireAuthentication } from '$lib/server/auth';
import {
	SESSION_NOTE_MAX_LENGTH,
	SessionMutationError,
	updateManagedSessionNote
} from '$lib/server/session-registry';

export const PUT: RequestHandler = async (event) => {
	requireAuthentication(event);
	const id = event.params.id;
	if (!id) throw error(400, 'Session ID is required.');

	let body: unknown;
	try {
		body = await event.request.json();
	} catch {
		throw error(400, 'A JSON body is required.');
	}

	const note = body && typeof body === 'object' && !Array.isArray(body)
		? (body as Record<string, unknown>).note
		: undefined;
	if (typeof note !== 'string') throw error(400, 'Note must be a string.');
	if (note.length > SESSION_NOTE_MAX_LENGTH) {
		throw error(400, `Note must be ${SESSION_NOTE_MAX_LENGTH.toLocaleString('en-US')} characters or fewer.`);
	}

	try {
		return json({ note: await updateManagedSessionNote(id, note) });
	} catch (cause) {
		if (cause instanceof SessionMutationError) throw error(404, cause.message);
		throw error(500, 'Vampire could not save the session note.');
	}
};
