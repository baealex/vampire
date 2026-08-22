import type { ManagedWorkspace, WorkspaceOrderMode, WorkspaceProcess } from '~/lib/shared/contracts/workspace.ts';
import { isAgentProcessLabel } from '~/lib/shared/contracts/workspace-agent.ts';

export const WORKSPACE_OUTPUT_SETTLE_MS = 8_000;
export const WORKSPACE_AGENT_OUTPUT_SETTLE_MS = 30_000;

export type WorkspaceActivityState = 'active' | 'review' | 'idle' | 'ended';
export type WorkspaceActivityRecord = {
  activeUntil: number;
  seenThroughAt: number;
};
export type WorkspaceActivityRecords = ReadonlyMap<string, WorkspaceActivityRecord>;

const WORKSPACE_PROCESS_COLORS = [
  'var(--color-agent)',
  'var(--color-command)',
  'var(--color-success)',
  'var(--color-info)',
  'var(--terminal-blue)',
  'var(--color-folder)',
  'var(--color-image)',
  'var(--color-renamed)',
  'var(--terminal-cyan)',
  'var(--terminal-magenta)',
  'var(--terminal-bright-red)',
  'var(--terminal-bright-yellow)',
] as const;

export function projectName(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() || path;
}

export function workspaceName(workspace: Pick<ManagedWorkspace, 'cwd' | 'workspaceLabel'>): string {
  return workspace.workspaceLabel?.trim() || projectName(workspace.cwd);
}

export function workspaceRepositoryName(workspace: Pick<ManagedWorkspace, 'cwd' | 'repositoryPath'>): string {
  return projectName(workspace.repositoryPath || workspace.cwd);
}

export function isWorktreeWorkspace(workspace: Pick<ManagedWorkspace, 'workspaceKind' | 'worktreeBranch'>): boolean {
  return workspace.workspaceKind === 'worktree' || Boolean(workspace.worktreeBranch);
}

export function workspaceProcess(workspace: ManagedWorkspace): WorkspaceProcess | null {
  if (workspace.state === 'missing') return null;
  const process = workspace.terminals?.[0]?.foregroundProcess ??
    workspace.foregroundProcess ?? { kind: 'shell', label: 'shell' };
  return { ...process, label: process.label.toLowerCase() };
}

export function workspaceOutputSettleMs(workspace: ManagedWorkspace): number {
  const process = workspaceProcess(workspace);
  return process?.kind === 'command' && isAgentProcessLabel(process.label)
    ? WORKSPACE_AGENT_OUTPUT_SETTLE_MS
    : WORKSPACE_OUTPUT_SETTLE_MS;
}

export function workspaceTrackedOutputAt(workspace: ManagedWorkspace): number | null {
  return workspace.terminals?.length > 0 ? workspace.terminals[0].lastOutputAt : workspace.lastOutputAt;
}

export function workspaceProcessColor(process: WorkspaceProcess): string {
  if (process.kind === 'shell') return 'var(--color-text-secondary)';

  const { label } = process;
  let hash = 0;
  for (const character of label.toLowerCase()) {
    hash = (hash * 31 + (character.codePointAt(0) ?? 0)) >>> 0;
  }
  return WORKSPACE_PROCESS_COLORS[hash % WORKSPACE_PROCESS_COLORS.length];
}

export function workspaceProcessHint(workspace: ManagedWorkspace): string {
  if (workspace.state === 'missing') return 'tmux session unavailable';
  const process = workspaceProcess(workspace);
  if (!process) return 'Shell is waiting for input';
  if (process.kind === 'command') return `Foreground command: ${process.label}`;
  return 'Shell is waiting for input';
}

export function workspaceIsActive(
  workspace: ManagedWorkspace,
  activityRecords: WorkspaceActivityRecords = new Map(),
  now = Date.now()
): boolean {
  return (
    workspace.state === 'running' &&
    (workspace.agentState === 'working' || (activityRecords.get(workspace.id)?.activeUntil ?? 0) > now)
  );
}

const WORKSPACE_ACTIVITY_PRIORITY: Record<WorkspaceActivityState, number> = {
  active: 0,
  review: 1,
  idle: 2,
  ended: 3,
};

export function workspaceActivityPriority(state: WorkspaceActivityState): number {
  return WORKSPACE_ACTIVITY_PRIORITY[state];
}

export function buildActivityOrder(
  workspaces: ManagedWorkspace[],
  previousOrder: string[],
  activityRecords: WorkspaceActivityRecords = new Map()
): string[] {
  const currentIds = new Set(workspaces.map((workspace) => workspace.id));
  const existingOrder = previousOrder.filter((workspaceId) => currentIds.has(workspaceId));
  const knownIds = new Set(existingOrder);
  const baseOrder = [
    ...existingOrder,
    ...workspaces.filter((workspace) => !knownIds.has(workspace.id)).map((workspace) => workspace.id),
  ];
  const states = new Map(
    workspaces.map((workspace) => [workspace.id, workspaceActivityState(workspace, activityRecords)])
  );
  const basePosition = new Map(baseOrder.map((workspaceId, index) => [workspaceId, index]));
  return [...baseOrder].sort(
    (left, right) =>
      workspaceActivityPriority(states.get(left) ?? 'idle') - workspaceActivityPriority(states.get(right) ?? 'idle') ||
      (basePosition.get(left) ?? Number.MAX_SAFE_INTEGER) - (basePosition.get(right) ?? Number.MAX_SAFE_INTEGER)
  );
}

export function reconcileWorkspaceOrder(workspaces: ManagedWorkspace[], manualOrder: string[]): string[] {
  const workspaceIds = new Set(workspaces.map((workspace) => workspace.id));
  const existingOrder = [...new Set(manualOrder)].filter((id) => workspaceIds.has(id));
  const orderedIds = new Set(existingOrder);
  return [...existingOrder, ...workspaces.map((workspace) => workspace.id).filter((id) => !orderedIds.has(id))];
}

export function workspaceActivityState(
  workspace: ManagedWorkspace,
  activityRecords: WorkspaceActivityRecords = new Map(),
  now = Date.now()
): WorkspaceActivityState {
  if (workspace.state === 'missing') return 'ended';
  const activity = activityRecords.get(workspace.id);
  if (workspaceIsActive(workspace, activityRecords, now)) return 'active';
  if ((workspaceTrackedOutputAt(workspace) ?? 0) > (activity?.seenThroughAt ?? 0)) return 'review';
  return 'idle';
}

export function workspaceActivityLabel(state: WorkspaceActivityState): string {
  if (state === 'active') return 'Working';
  if (state === 'review') return 'Review';
  if (state === 'ended') return 'Ended';
  return 'Idle';
}

export function workspaceActivityHint(
  workspace: ManagedWorkspace,
  activityRecords: WorkspaceActivityRecords = new Map(),
  now = Date.now()
): string {
  if (workspace.state === 'missing') return 'Shell is offline';
  const state = workspaceActivityState(workspace, activityRecords, now);
  if (state === 'active') return 'Terminal is working; check back later';
  if (state === 'review') return 'Terminal output is ready and needs review';
  return 'Shell is online and up to date';
}

export function maxTimestamp(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.max(left, right);
}

export function latestWorkspaceOutputAt(workspace: ManagedWorkspace): number {
  return workspaceTrackedOutputAt(workspace) ?? workspace.lastActiveAt;
}

export function sortWorkspaces(
  workspaces: ManagedWorkspace[],
  mode: WorkspaceOrderMode,
  manualOrder: string[],
  activityOrder: string[] = []
): ManagedWorkspace[] {
  if (mode === 'activity') {
    const position = new Map(activityOrder.map((id, index) => [id, index]));
    return [...workspaces].sort(
      (left, right) =>
        (position.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (position.get(right.id) ?? Number.MAX_SAFE_INTEGER) ||
        left.createdAt - right.createdAt ||
        left.id.localeCompare(right.id)
    );
  }

  const position = new Map(manualOrder.map((id, index) => [id, index]));
  return [...workspaces].sort(
    (left, right) =>
      (position.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (position.get(right.id) ?? Number.MAX_SAFE_INTEGER) ||
      left.createdAt - right.createdAt
  );
}

export function formatWorkspaceTimestamp(value: number, now = Date.now()): string {
  const elapsed = Math.max(0, now - value);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}
