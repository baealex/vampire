import type { WorkspaceEntryKind } from '@vampire/lib/shared/contracts/repository.ts';

export type RepositoryEntry = { kind: WorkspaceEntryKind; path: string };

export function repositoryParentPath(path: string) {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

export function repositoryBasename(path: string) {
  return path.slice(path.lastIndexOf('/') + 1);
}
