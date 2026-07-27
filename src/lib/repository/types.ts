export type RepositoryChange = {
	path: string;
	status: string;
	previousPath?: string;
};

export type RepositorySnapshot = {
	isGitRepository: boolean;
	files: string[];
	directories?: string[];
	changes: RepositoryChange[];
	truncated: boolean;
};

export type RepositorySelection = {
	kind: 'file' | 'diff';
	path: string;
};

export type WorkspaceFile = {
	path: string;
	content: string;
	size: number;
	modifiedAt: number;
	version: string;
};

export type DiffSection = {
	kind: 'staged' | 'working' | 'untracked';
	patch: string;
};

export type RepositoryDiff = {
	path: string;
	sections: DiffSection[];
};

export type FileTreeRow = {
	kind: 'directory' | 'file';
	name: string;
	path: string;
	depth: number;
};

export type DiffLine = {
	kind: 'addition' | 'deletion' | 'context' | 'hunk' | 'meta';
	content: string;
	oldLine?: number;
	newLine?: number;
};
