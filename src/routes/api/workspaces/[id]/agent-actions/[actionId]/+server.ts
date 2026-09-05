import { error, json, type RequestHandler } from '@sveltejs/kit';
import { requireAuthentication } from '~/lib/features/auth/server/auth.server.ts';
import {
  describeWorkspaceAgentAction,
  submitWorkspaceAgentAction,
  WorkspaceAgentActionError,
} from '~/lib/app/server/workspace-agent-actions.server.ts';
import { WorkspaceAutomationMutationError } from '~/lib/features/workspace/server/workspace-automations.server.ts';
import { WorkspaceBackgroundMutationError } from '~/lib/features/workspace/server/workspace-background-agent-support.server.ts';
import {
  isWorkspaceAgentActionId,
  type WorkspaceAgentActionId,
} from '~/lib/shared/contracts/workspace-agent-actions.ts';

function routeInput(event: Parameters<RequestHandler>[0]): { workspaceId: string; actionId: WorkspaceAgentActionId } {
  const workspaceId = event.params.id;
  if (!workspaceId) throw error(400, 'Workspace ID is required.');
  const actionId = event.params.actionId;
  if (!isWorkspaceAgentActionId(actionId)) throw error(404, 'Agent action was not found.');
  return { workspaceId, actionId };
}

function actionError(cause: unknown): never {
  if (cause instanceof WorkspaceAgentActionError) {
    if (cause.reason === 'not-found' || cause.reason === 'unsupported-action') throw error(404, cause.message);
    if (cause.reason === 'not-running' || cause.reason === 'no-process') throw error(409, cause.message);
    throw error(400, cause.message);
  }
  if (cause instanceof WorkspaceAutomationMutationError) {
    if (cause.reason === 'not-found') throw error(404, cause.message);
    if (cause.reason === 'conflict' || cause.reason === 'limit') throw error(409, cause.message);
    throw error(400, cause.message);
  }
  if (cause instanceof WorkspaceBackgroundMutationError) {
    if (cause.reason === 'not-found') throw error(404, cause.message);
    if (cause.reason === 'conflict' || cause.reason === 'limit') throw error(409, cause.message);
    throw error(400, cause.message);
  }
  throw error(500, 'Vampire could not prepare the agent action.');
}

export const GET: RequestHandler = async (event) => {
  requireAuthentication(event);
  const { workspaceId, actionId } = routeInput(event);
  try {
    return json(
      { action: await describeWorkspaceAgentAction(workspaceId, actionId) },
      { headers: { 'cache-control': 'no-store' } }
    );
  } catch (cause) {
    actionError(cause);
  }
};

export const POST: RequestHandler = async (event) => {
  requireAuthentication(event);
  const { workspaceId, actionId } = routeInput(event);
  const body: unknown = await event.request.json().catch(() => undefined);
  const request =
    body && typeof body === 'object' && !Array.isArray(body) && 'request' in body ? body.request : undefined;
  try {
    return json({ submission: await submitWorkspaceAgentAction(workspaceId, actionId, request) });
  } catch (cause) {
    actionError(cause);
  }
};
