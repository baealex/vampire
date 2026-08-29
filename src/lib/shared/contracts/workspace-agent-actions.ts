export const WORKSPACE_AGENT_ACTION_REQUEST_MAX_LENGTH = 4_000;

export const WORKSPACE_AGENT_ACTION_IDS = ['note', 'status-widget'] as const;

export type WorkspaceAgentActionId = (typeof WORKSPACE_AGENT_ACTION_IDS)[number];

export type WorkspaceAgentActionContext = {
  label: string;
  value: string;
  description?: string;
};

export type WorkspaceAgentActionDescriptor = {
  id: WorkspaceAgentActionId;
  title: string;
  description: string;
  target: {
    workspaceId: string;
    workspaceLabel: string;
    agentLabel: string;
  };
  context: WorkspaceAgentActionContext[];
  requestLabel: string;
  requestPlaceholder: string;
  defaultRequest: string;
};

export type WorkspaceAgentActionSubmission = {
  actionId: WorkspaceAgentActionId;
  status: 'queued';
  queuedAt: number;
  prompt: string;
};

export function isWorkspaceAgentActionId(value: unknown): value is WorkspaceAgentActionId {
  return typeof value === 'string' && WORKSPACE_AGENT_ACTION_IDS.some((candidate) => candidate === value);
}
