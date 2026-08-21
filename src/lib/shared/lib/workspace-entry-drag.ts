import type { WorkspaceEntryKind } from '../contracts/repository.ts';

export type { WorkspaceEntryKind };

export interface WorkspaceEntryDragData {
  path: string;
  kind: WorkspaceEntryKind;
}

export interface TerminalPathInsertionRequest {
  entries: WorkspaceEntryDragData[];
  token: number;
}

export const WORKSPACE_ENTRY_DRAG_TYPE = 'application/x-vampire-workspace-entry';

function isWorkspaceEntryKind(value: unknown): value is WorkspaceEntryKind {
  return value === 'file' || value === 'directory';
}

export function parseWorkspaceEntryDrag(value: string): WorkspaceEntryDragData | undefined {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || !('path' in parsed) || !('kind' in parsed)) return undefined;
    const path = parsed.path;
    const kind = parsed.kind;
    if (
      typeof path !== 'string' ||
      !path ||
      path.includes('\0') ||
      path.startsWith('/') ||
      path === '.' ||
      path === '..' ||
      path.startsWith('../')
    ) {
      return undefined;
    }
    if (!isWorkspaceEntryKind(kind)) return undefined;
    return { path, kind };
  } catch {
    return undefined;
  }
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function workspaceEntryDragText({ path, kind }: WorkspaceEntryDragData): string {
  return shellQuote(kind === 'directory' ? `${path}/` : path);
}

export function workspaceEntryParent(path: string): string {
  const separator = path.lastIndexOf('/');
  return separator < 0 ? '' : path.slice(0, separator);
}

export function workspaceEntryCanMoveToDirectory(entry: WorkspaceEntryDragData, targetDirectory: string): boolean {
  if (workspaceEntryParent(entry.path) === targetDirectory) return false;
  return (
    entry.kind !== 'directory' || (targetDirectory !== entry.path && !targetDirectory.startsWith(`${entry.path}/`))
  );
}
