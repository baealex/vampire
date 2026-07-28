/** @typedef {'file' | 'directory'} WorkspaceEntryKind */
/** @typedef {{ path: string; kind: WorkspaceEntryKind }} WorkspaceEntryDragData */

export const WORKSPACE_ENTRY_DRAG_TYPE = 'application/x-vampire-workspace-entry';

/** @param {unknown} value */
function isWorkspaceEntryKind(value) {
	return value === 'file' || value === 'directory';
}

/**
 * @param {string} value
 * @returns {WorkspaceEntryDragData | undefined}
 */
export function parseWorkspaceEntryDrag(value) {
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

/** @param {string} value */
function shellQuote(value) {
	if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/** @param {WorkspaceEntryDragData} entry */
export function workspaceEntryDragText({ path, kind }) {
	return shellQuote(kind === 'directory' ? `${path}/` : path);
}
