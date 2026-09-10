import { json, type RequestHandler } from '~/lib/server/http-handler.server.ts';
import { requireAuthentication } from '~/lib/features/auth/server/auth.server.ts';
import { getSystemMetrics } from '~/lib/features/system/server/system-metrics.server.ts';

export const GET: RequestHandler = async (event) => {
  requireAuthentication(event);
  return json(getSystemMetrics());
};
