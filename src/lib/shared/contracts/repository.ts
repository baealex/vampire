export type RepositoryChange = {
  path: string;
  status: string;
  previousPath?: string;
};

export type RepositoryChangeStats = {
  additions: number;
  deletions: number;
};

export type RepositoryDiscardResult = {
  path: string;
  untracked: boolean;
};

export type RepositorySnapshot = {
  isGitRepository: boolean;
  files: string[];
  directories: string[];
  ignored: string[];
  changes: RepositoryChange[];
  changeStats: RepositoryChangeStats;
  truncated: boolean;
};

export type RepositoryDirectoryListing = {
  files: string[];
  directories: string[];
  ignored: string[];
  truncated: boolean;
};

export type RepositorySelection = {
  kind: 'file' | 'diff';
  path: string;
};

export type RepositoryTab = 'changes' | 'files';

export type WorkspaceFile = {
  path: string;
  content: string;
  size: number;
  modifiedAt: number;
  version: string;
};

export type WorkspaceUploadConflict = 'reject' | 'overwrite' | 'rename';

export type WorkspaceUploadResult = {
  path: string;
  size: number;
  renamed: boolean;
};

export type WorkspaceEntryKind = 'file' | 'directory';
export type WorkspaceMoveConflict = 'reject' | 'rename';

export type WorkspaceMoveResult = {
  fromPath: string;
  path: string;
  kind: WorkspaceEntryKind;
  renamed: boolean;
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
