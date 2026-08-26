import { error, json, type RequestHandler } from '@sveltejs/kit';
import {
  declineWorkspaceKingControl,
  handOverWorkspaceToKing,
  takeControlFromKing,
} from '~/lib/app/server/workspace-king-control.ts';
import { WorkspaceMutationError } from '~/lib/app/server/workspace-registry.ts';
import { requireAuthentication } from '~/lib/features/auth/server/auth.ts';

type ControlAction = 'handoff' | 'decline' | 'take-control';

function isControlAction(value: unknown): value is ControlAction {
  return value === 'handoff' || value === 'decline' || value === 'take-control';
}

export const POST: RequestHandler = async (event) => {
  requireAuthentication(event);
  const workspaceId = event.params.id;
  if (!workspaceId) throw error(400, 'Workspace ID is required.');
  const body: unknown = await event.request.json().catch(() => undefined);
  if (!body || typeof body !== 'object' || Array.isArray(body) || !('action' in body)) {
    throw error(400, 'A workspace control action is required.');
  }
  if (!isControlAction(body.action)) throw error(400, 'Workspace control action is invalid.');
  const reason = 'reason' in body ? body.reason : undefined;
  if (reason !== undefined && typeof reason !== 'string') throw error(400, 'Handoff reason must be text.');

  try {
    if (body.action === 'handoff') return json(await handOverWorkspaceToKing(workspaceId, reason));
    if (body.action === 'decline') return json(await declineWorkspaceKingControl(workspaceId));
    return json(await takeControlFromKing(workspaceId));
  } catch (cause) {
    if (cause instanceof WorkspaceMutationError) {
      const status = cause.reason === 'not-found' || cause.reason === 'king-not-found' ? 404 : 409;
      throw error(status, cause.message);
    }
    throw error(500, cause instanceof Error ? cause.message : 'Vampire could not change workspace control.');
  }
};
