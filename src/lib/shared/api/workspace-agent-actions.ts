import { requestJson } from './request.ts';
import type {
  WorkspaceAgentActionDescriptor,
  WorkspaceAgentActionId,
  WorkspaceAgentActionSubmission,
} from '../contracts/workspace-agent-actions.ts';

const AGENT_ACTION_REQUEST_TIMEOUT_MS = 15_000;

function actionUrl(workspaceId: string, actionId: WorkspaceAgentActionId): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/agent-actions/${encodeURIComponent(actionId)}`;
}

async function requestAgentAction<T>(path: string, init: RequestInit, fallback: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AGENT_ACTION_REQUEST_TIMEOUT_MS);
  try {
    return await requestJson<T>(path, { ...init, signal: controller.signal }, fallback);
  } catch (error) {
    if (controller.signal.aborted) throw new Error('The agent request timed out. Try again.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function loadWorkspaceAgentAction(
  workspaceId: string,
  actionId: WorkspaceAgentActionId
): Promise<WorkspaceAgentActionDescriptor> {
  return requestAgentAction<{ action: WorkspaceAgentActionDescriptor }>(
    actionUrl(workspaceId, actionId),
    { cache: 'no-store' },
    'Unable to prepare the agent request'
  ).then(({ action }) => action);
}

export function queueWorkspaceAgentAction(
  workspaceId: string,
  actionId: WorkspaceAgentActionId,
  request: string
): Promise<WorkspaceAgentActionSubmission> {
  return requestAgentAction<{ submission: WorkspaceAgentActionSubmission }>(
    actionUrl(workspaceId, actionId),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request }),
    },
    'Unable to queue the agent request'
  ).then(({ submission }) => submission);
}
