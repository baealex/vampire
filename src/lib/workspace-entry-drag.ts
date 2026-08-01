export type WorkspaceEntryKind = 'file' | 'directory';

export interface WorkspaceEntryDragData {
	path: string;
	kind: WorkspaceEntryKind;
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
		if (typeof path !== 'string' || !path || path.includes('\0') || path.startsWith('/') || path === '.' || path === '..' || path.startsWith('../')) {
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
