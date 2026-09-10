import { requireAuthentication } from '~/lib/features/auth/server/auth.server.ts';
import { listManagedWorkspaceAutomationGroups } from '~/lib/features/workspace/server/workspace-automations.server.ts';
import { json, type RequestHandler } from '~/lib/server/http-handler.server.ts';

export const GET: RequestHandler = async (event) => {
  requireAuthentication(event);
  return json({ groups: await listManagedWorkspaceAutomationGroups() }, { headers: { 'cache-control': 'no-store' } });
};
