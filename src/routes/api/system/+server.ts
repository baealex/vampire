import { json } from '@sveltejs/kit';
import { requireAuthentication } from '~/lib/features/auth/server/auth';
import { getSystemMetrics } from '~/lib/features/system/server/system-metrics';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
  requireAuthentication(event);
  return json(getSystemMetrics());
};
