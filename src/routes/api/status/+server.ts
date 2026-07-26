import { json } from '@sveltejs/kit';
import { authenticationRequired, isAuthenticated } from '$lib/server/auth';
import { getTmuxStatus } from '$lib/server/tmux';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => json({
	authenticationRequired: authenticationRequired(),
	authenticated: isAuthenticated(event),
	tmux: await getTmuxStatus()
});
