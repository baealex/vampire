import { json, type RequestHandler } from '@sveltejs/kit';
import { authenticate, clearAuthentication } from '$lib/server/auth';

export const POST: RequestHandler = async (event) => {
	await authenticate(event);
	return json({ ok: true });
};

export const DELETE: RequestHandler = async (event) => {
	clearAuthentication(event);
	return json({ ok: true });
};
