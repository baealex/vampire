import type { AgentState } from './workspace-agent.ts';
import type { RepositoryChange } from './repository.ts';

export type LaunchProfile = {
  id: string;
  name: string;
  command: string;
};

export type WorkspaceProcess = {
  kind: 'shell' | 'command';
  label: string;
};

export type WorkspaceTerminal = {
  id: string;
  index: number;
  name: string;
  active: boolean;
  lastOutputAt: number | null;
  foregroundProcess: WorkspaceProcess | null;
  command: string | null;
  startedAt: number | null;
  state: 'running' | 'exited';
  exitCode: number | null;
  terminalKind?: 'main' | 'background' | 'king-task';
  kingAttemptId?: string | null;
};

export type WorkspaceKingControl = {
  state: 'manual' | 'requested' | 'king';
  reason: string;
  requestedAt: number | null;
  changedAt: number;
  lastAction: 'requested' | 'granted' | 'declined' | 'released';
  notifiedAt: number | null;
  handoffSnapshot: WorkspaceHandoffSnapshot | null;
};

export type WorkspaceHandoffSnapshot = {
  capturedAt: number;
  checkoutKey: string | null;
  isGitRepository: boolean;
  headRevision: string | null;
  changes: RepositoryChange[];
  changeFingerprints: Array<RepositoryChange & { diffHash: string }> | null;
  repositoryStateHash: string | null;
};

export type ManagedWorkspace = {
  id: string;
  tmuxSession: string;
  cwd: string;
  workspaceKind?: 'directory' | 'worktree' | 'king';
  repositoryPath?: string;
  workspaceLabel?: string;
  worktreeBranch?: string;
  managedWorktree?: boolean;
  checkoutKey?: string;
  kingControl?: WorkspaceKingControl;
  createdAt: number;
  lastActiveAt: number;
  notePreview: string;
  favoriteCommands: string[];
  startupProfileId: string | null;
  lastOutputAt: number | null;
  state: 'running' | 'missing';
  attachedClients: number;
  foregroundProcess: WorkspaceProcess | null;
  terminals: WorkspaceTerminal[];
  agentState?: AgentState;
  isGitRepository: boolean;
  workspaceAvailable?: boolean;
};

export type WorkspaceOrderMode = 'activity' | 'manual';

export type WorkspacePreferences = {
  workspaceOrderMode: WorkspaceOrderMode;
  manualWorkspaceOrder: string[];
};

export type MobilePanel = 'workspaces' | 'repository' | 'note';

export function workspaceAcceptsOwnerWrites(workspace: Pick<ManagedWorkspace, 'kingControl'>): boolean {
  return workspace.kingControl?.state !== 'king';
}
