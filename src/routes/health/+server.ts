import { json } from '~/lib/server/http-handler.server.ts';

export function GET() {
  return json({ status: 'ok' });
}
