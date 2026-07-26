import { json } from '@sveltejs/kit';
import { requireAuthentication } from '$lib/server/auth';
import { getSystemMetrics } from '$lib/server/system-metrics';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
	requireAuthentication(event);
	return json(getSystemMetrics());
};
