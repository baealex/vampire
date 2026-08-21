import { error, json, type RequestHandler } from '@sveltejs/kit';
import { requireAuthentication } from '$lib/server/auth';
import { findManagedSessionNote, SessionMutationError, updateManagedSessionNote } from '$lib/server/session-registry';
import { normalizeSessionNote, sessionNoteByteLength, SESSION_NOTE_MAX_BYTES } from '$lib/server/session-note';

export const GET: RequestHandler = async (event) => {
	requireAuthentication(event);
	const id = event.params.id;
	if (!id) throw error(400, 'Session ID is required.');

	const note = await findManagedSessionNote(id);
	if (note === undefined) throw error(404, 'Session was not found.');
	return json({ note }, { headers: { 'cache-control': 'no-store' } });
};

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
	const normalizedNote = normalizeSessionNote(note);
	if (sessionNoteByteLength(normalizedNote) > SESSION_NOTE_MAX_BYTES) {
		throw error(413, 'Note must be 128 KB or smaller.');
	}

	try {
		return json({ notePreview: await updateManagedSessionNote(id, note) });
	} catch (cause) {
		if (cause instanceof SessionMutationError) throw error(404, cause.message);
		throw error(500, 'Vampire could not save the session note.');
	}
};
