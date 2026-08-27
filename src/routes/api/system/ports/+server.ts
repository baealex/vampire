import { error, json, type RequestHandler } from '@sveltejs/kit';
import { requireAuthentication } from '~/lib/features/auth/server/auth.server.ts';
import { ListeningPortError, listListeningPorts } from '~/lib/features/system/server/listening-ports.server.ts';

function inspectionErrorStatus(reason: ListeningPortError['reason']): number {
  if (reason === 'unsupported-platform') return 501;
  if (reason === 'tool-unavailable') return 503;
  return 500;
}

export const GET: RequestHandler = async (event) => {
  requireAuthentication(event);
  try {
    return json({ ports: await listListeningPorts() });
  } catch (cause) {
    if (cause instanceof ListeningPortError) throw error(inspectionErrorStatus(cause.reason), cause.message);
    throw error(500, 'Vampire could not inspect listening ports.');
  }
};
