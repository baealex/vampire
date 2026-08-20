import type { AgentState } from './agent.ts';

export type LaunchProfile = {
	id: string;
	name: string;
	command: string;
};

export type SessionProcess = {
	kind: 'shell' | 'command';
	label: string;
};

export type SessionTerminal = {
	id: string;
	index: number;
	name: string;
	active: boolean;
	lastOutputAt: number | null;
	foregroundProcess: SessionProcess | null;
	command: string | null;
	startedAt: number | null;
	state: 'running' | 'exited';
	exitCode: number | null;
};

export type ManagedSession = {
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
	favoriteCommands: string[];
	startupProfileId: string | null;
	lastOutputAt: number | null;
	state: 'running' | 'missing';
	attachedClients: number;
	foregroundProcess: SessionProcess | null;
	terminals: SessionTerminal[];
	agentState?: AgentState;
	isGitRepository: boolean;
	workspaceAvailable?: boolean;
};

export type SessionOrderMode = 'activity' | 'manual';

export type WorkspacePreferences = {
	sessionOrderMode: SessionOrderMode;
	manualSessionOrder: string[];
};

export type MobilePanel = 'sessions' | 'repository';
