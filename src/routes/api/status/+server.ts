import { json } from '@sveltejs/kit';
import { authenticationRequired, isAuthenticated } from '$lib/server/auth';
import { getSystemMetrics } from '$lib/server/system-metrics';
import { getTmuxStatus } from '$lib/server/tmux';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
	const authenticated = isAuthenticated(event);
	return json({
		authenticationRequired: authenticationRequired(),
		authenticated,
		tmux: await getTmuxStatus(),
		system: authenticated ? getSystemMetrics() : undefined
	});
};
