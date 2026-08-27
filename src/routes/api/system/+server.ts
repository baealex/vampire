import { json } from '@sveltejs/kit';
import { requireAuthentication } from '~/lib/features/auth/server/auth.server.ts';
import { getSystemMetrics } from '~/lib/features/system/server/system-metrics.server.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
  requireAuthentication(event);
  return json(getSystemMetrics());
};
