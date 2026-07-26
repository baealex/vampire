import { error, json, type RequestHandler } from '@sveltejs/kit';
import { requireAuthentication } from '$lib/server/auth';
import { createManagedSession, listManagedSessions, SessionLaunchError } from '$lib/server/session-registry';

export const GET: RequestHandler = async (event) => {
	requireAuthentication(event);
	return json({ sessions: await listManagedSessions() });
};

export const POST: RequestHandler = async (event) => {
	requireAuthentication(event);
	const body: unknown = await event.request.json().catch(() => undefined);
	const cwd = body && typeof body === 'object' && !Array.isArray(body) && 'cwd' in body ? body.cwd : undefined;
	if (typeof cwd !== 'string') throw error(400, 'Working directory is required.');

	try {
		const session = await createManagedSession({ cwd });
		return json({ session }, { status: 201 });
	} catch (cause) {
		if (cause instanceof SessionLaunchError) {
			const status = cause.reason === 'invalid-cwd' ? 400 : 500;
			throw error(status, cause.message);
		}
		throw error(500, 'Vampire could not create the session.');
	}
};
