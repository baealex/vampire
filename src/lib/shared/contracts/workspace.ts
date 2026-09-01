import type { AgentState } from './workspace-agent.ts';
import type { WorkspaceComposerPromptPreview } from './workspace-composer-history.ts';

export type LaunchProfile = {
  id: string;
  name: string;
  command: string;
};

export type LaunchProfileSettings = {
  launchProfiles: LaunchProfile[];
  defaultStartupProfileId: string | null;
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
};

export type ManagedWorkspace = {
  id: string;
  tmuxSession: string;
  cwd: string;
  workspaceKind?: 'directory' | 'worktree';
  repositoryPath?: string;
  workspaceLabel?: string;
  worktreeBranch?: string;
  createdAt: number;
  lastActiveAt: number;
  notePreview: string;
  composerPromptPreview: WorkspaceComposerPromptPreview | null;
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

export type MobilePanel = 'workspaces' | 'repository' | 'note' | 'background';
