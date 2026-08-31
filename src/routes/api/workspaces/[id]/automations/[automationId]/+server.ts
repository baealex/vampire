import { error, json, type RequestHandler } from '@sveltejs/kit';
import { requireAuthentication } from '~/lib/features/auth/server/auth.server.ts';
import {
  deleteManagedWorkspaceAutomation,
  WorkspaceAutomationMutationError,
  setManagedWorkspaceAutomationEnabled,
  updateManagedWorkspaceAutomation,
} from '~/lib/features/workspace/server/workspace-automations.server.ts';

function automationError(cause: WorkspaceAutomationMutationError): never {
  throw error(
    cause.reason === 'not-found' || cause.reason === 'automation-not-found'
      ? 404
      : cause.reason === 'limit'
        ? 409
        : 400,
    cause.message
  );
}

function routeIds(event: Parameters<RequestHandler>[0]): { workspaceId: string; automationId: string } {
  const workspaceId = event.params.id;
  const automationId = event.params.automationId;
  if (!workspaceId) throw error(400, 'Workspace ID is required.');
  if (!automationId) throw error(400, 'Automation ID is required.');
  return { workspaceId, automationId };
}

export const PATCH: RequestHandler = async (event) => {
  requireAuthentication(event);
  const { workspaceId, automationId } = routeIds(event);
  const body: unknown = await event.request.json().catch(() => undefined);
  const enabled =
    body && typeof body === 'object' && !Array.isArray(body) && 'enabled' in body ? body.enabled : undefined;
  if (enabled !== undefined && typeof enabled !== 'boolean') throw error(400, 'Enabled must be a boolean.');
  if (
    typeof enabled === 'boolean' &&
    body &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    ('name' in body || 'prompt' in body || 'schedule' in body)
  ) {
    throw error(400, 'Enabled and automation settings must be updated separately.');
  }
  try {
    if (typeof enabled === 'boolean') {
      return json({
        automation: await setManagedWorkspaceAutomationEnabled(workspaceId, automationId, enabled),
      });
    }
    return json({
      automation: await updateManagedWorkspaceAutomation(workspaceId, automationId, body),
    });
  } catch (cause) {
    if (cause instanceof WorkspaceAutomationMutationError) automationError(cause);
    throw error(500, 'Vampire could not update the workspace automation.');
  }
};
export const DELETE: RequestHandler = async (event) => {
  requireAuthentication(event);
  const { workspaceId, automationId } = routeIds(event);
  try {
    await deleteManagedWorkspaceAutomation(workspaceId, automationId);
    return json({ ok: true });
  } catch (cause) {
    if (cause instanceof WorkspaceAutomationMutationError) automationError(cause);
    throw error(500, 'Vampire could not delete the workspace automation.');
  }
};
