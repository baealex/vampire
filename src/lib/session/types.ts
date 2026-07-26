export type SessionProcess = {
	kind: 'shell' | 'agent' | 'command';
	label: string;
};

export type ManagedSession = {
	id: string;
	tmuxSession: string;
	cwd: string;
	createdAt: number;
	lastActiveAt: number;
	note: string;
	lastOutputAt: number | null;
	state: 'running' | 'missing';
	attachedClients: number;
	foregroundProcess: SessionProcess | null;
};

export type SessionOrderMode = 'recent' | 'manual';

export type MobilePanel = 'sessions' | 'repository';
