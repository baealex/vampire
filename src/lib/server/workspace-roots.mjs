import { readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { parseWorkspaceRootPaths } from '../../../scripts/config.mjs';

/** @typedef {'invalid-path' | 'outside-root' | 'not-found' | 'not-directory' | 'unreadable'} WorkspaceRootErrorReason */
/** @typedef {{ id: string; label: string; path: string }} WorkspaceRoot */
/** @typedef {{ name: string; path: string }} WorkspaceDirectoryEntry */

const MAX_DIRECTORY_ENTRY_COUNT = 512;
const IGNORED_DIRECTORY_NAMES = new Set(['.git']);

export class WorkspaceRootError extends Error {
	/** @type {WorkspaceRootErrorReason} */
	reason;

	/**
	 * @param {WorkspaceRootErrorReason} reason
	 * @param {string} message
	 */
	constructor(reason, message) {
		super(message);
		this.reason = reason;
	}
}

/**
 * @param {WorkspaceRootErrorReason} reason
 * @param {string} message
 */
function workspaceRootError(reason, message) {
	return new WorkspaceRootError(reason, message);
}

/**
 * @param {string} root
 * @param {string} target
 */
function staysInside(root, target) {
	const pathFromRoot = relative(root, target);
	return pathFromRoot === '' || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..' && !isAbsolute(pathFromRoot));
}

/**
 * @param {string} path
 */
function validateAbsolutePath(path) {
	if (typeof path !== 'string' || path.length === 0 || path.includes('\0') || !isAbsolute(path)) {
		throw workspaceRootError('invalid-path', 'Workspace path must be an absolute path.');
	}
}

/**
 * @param {string} path
 * @param {number} index
 * @returns {WorkspaceRoot}
 */
function createWorkspaceRoot(path, index) {
	const home = homedir();
	return {
		id: `root-${index + 1}`,
		label: path === home ? 'Home' : basename(path) || path,
		path
	};
}

/** @returns {Promise<WorkspaceRoot[]>} */
export async function listWorkspaceRoots() {
	const configuredPaths = parseWorkspaceRootPaths(process.env.VAMPIRE_WORKSPACE_ROOTS);
	const roots = [];
	const seen = new Set();

	for (const configuredPath of configuredPaths) {
		try {
			const canonicalPath = await realpath(configuredPath);
			if (!(await stat(canonicalPath)).isDirectory() || seen.has(canonicalPath)) continue;
			seen.add(canonicalPath);
			roots.push(createWorkspaceRoot(canonicalPath, roots.length));
		} catch {
			// A stale configured root should not make the whole workspace UI unavailable.
		}
	}

	return roots;
}

/**
 * Resolve a path against a set of canonical, existing workspace roots.
 * The realpath check is intentional: a symlinked directory cannot escape the allowlist.
 *
 * @param {string} cwd
 * @param {WorkspaceRoot[]} roots
 */
export async function resolveWorkspaceDirectory(cwd, roots) {
	validateAbsolutePath(cwd);
	const lexicalTarget = resolve(cwd);
	const lexicalRoot = roots
		.filter((root) => staysInside(root.path, lexicalTarget))
		.sort((left, right) => right.path.length - left.path.length)[0];
	if (!lexicalRoot) {
		throw workspaceRootError('outside-root', 'This directory is outside the permitted workspace roots.');
	}

	let canonicalTarget;
	try {
		canonicalTarget = await realpath(lexicalTarget);
	} catch {
		throw workspaceRootError('not-found', 'Workspace directory is no longer available.');
	}

	const root = roots
		.filter((candidate) => staysInside(candidate.path, canonicalTarget))
		.sort((left, right) => right.path.length - left.path.length)[0];
	if (!root) {
		throw workspaceRootError('outside-root', 'This directory is outside the permitted workspace roots.');
	}

	let details;
	try {
		details = await stat(canonicalTarget);
	} catch {
		throw workspaceRootError('unreadable', 'The workspace directory could not be read.');
	}
	if (!details.isDirectory()) throw workspaceRootError('not-directory', 'Only directories can be used as workspaces.');

	return { root, path: canonicalTarget };
}

/** @param {string} cwd */
export async function resolveAllowedWorkspaceDirectory(cwd) {
	const roots = await listWorkspaceRoots();
	return (await resolveWorkspaceDirectory(cwd, roots)).path;
}

/**
 * Validate an existing stored session path without applying the new-root policy.
 * This keeps previously registered workspaces restartable after an allowlist is introduced.
 *
 * @param {string} cwd
 */
export async function resolveExistingWorkspaceDirectory(cwd) {
	validateAbsolutePath(cwd);
	const target = resolve(cwd);
	try {
		const canonicalTarget = await realpath(target);
		if (!(await stat(canonicalTarget)).isDirectory()) throw workspaceRootError('not-directory', 'Only directories can be used as workspaces.');
		return canonicalTarget;
	} catch (cause) {
		if (cause instanceof WorkspaceRootError) throw cause;
		throw workspaceRootError('not-found', 'Workspace directory is no longer available.');
	}
}

/**
 * @param {string | undefined} cwd
 * @returns {Promise<{ roots: WorkspaceRoot[]; current: null | { rootId: string; label: string; path: string }; parentPath: string | null; directories: WorkspaceDirectoryEntry[]; truncated: boolean }>}
 */
export async function readWorkspaceDirectory(cwd) {
	const roots = await listWorkspaceRoots();
	if (!cwd) {
		return {
			roots,
			current: null,
			parentPath: null,
			directories: [],
			truncated: false
		};
	}

	const resolved = await resolveWorkspaceDirectory(cwd, roots);
	let entries;
	try {
		entries = await readdir(resolved.path, { withFileTypes: true });
	} catch {
		throw workspaceRootError('unreadable', 'The workspace directory could not be read.');
	}

	entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
	/** @type {WorkspaceDirectoryEntry[]} */
	const directories = [];
	let truncated = false;
	for (const entry of entries) {
		if (entry.isSymbolicLink() || !entry.isDirectory() || IGNORED_DIRECTORY_NAMES.has(entry.name)) continue;
		if (directories.length >= MAX_DIRECTORY_ENTRY_COUNT) {
			truncated = true;
			break;
		}
		directories.push({ name: entry.name, path: resolve(resolved.path, entry.name) });
	}

	const parentPath = resolved.path === resolved.root.path ? null : dirname(resolved.path);
	return {
		roots,
		current: {
			rootId: resolved.root.id,
			label: basename(resolved.path) || resolved.root.label,
			path: resolved.path
		},
		parentPath,
		directories,
		truncated
	};
}
