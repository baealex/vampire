import { authenticate, clearAuthentication } from '~/lib/features/auth/server/auth.server.ts';
import { json, type RequestHandler } from '~/lib/server/http-handler.server.ts';

export const POST: RequestHandler = async (event) => {
  await authenticate(event);
  return json({ ok: true });
};

export const DELETE: RequestHandler = async (event) => {
  clearAuthentication(event);
  return json({ ok: true });
};
