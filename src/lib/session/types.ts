export type SessionProcess = {
	kind: 'shell' | 'command';
	label: string;
};

export type ManagedSession = {
	id: string;
	tmuxSession: string;
	cwd: string;
	createdAt: number;
	lastActiveAt: number;
	notePreview: string;
	lastOutputAt: number | null;
	state: 'running' | 'missing';
	attachedClients: number;
	foregroundProcess: SessionProcess | null;
	isGitRepository: boolean;
};

export type SessionOrderMode = 'activity' | 'manual';

export type MobilePanel = 'sessions' | 'repository';
