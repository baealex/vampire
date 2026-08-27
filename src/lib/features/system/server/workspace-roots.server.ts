import { readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import { parseWorkspaceRootPaths } from '~/lib/server/runtime-config.ts';
import { pathStaysInside } from '~/lib/server/path-policy.ts';

export type WorkspaceRootErrorReason = 'invalid-path' | 'outside-root' | 'not-found' | 'not-directory' | 'unreadable';

export interface WorkspaceRoot {
  id: string;
  label: string;
  path: string;
}

export interface WorkspaceDirectoryEntry {
  name: string;
  path: string;
}

export interface WorkspaceDirectoryListing {
  roots: WorkspaceRoot[];
  current: null | { rootId: string; label: string; path: string };
  parentPath: string | null;
  directories: WorkspaceDirectoryEntry[];
  truncated: boolean;
}

const MAX_DIRECTORY_ENTRY_COUNT = 512;
const IGNORED_DIRECTORY_NAMES = new Set(['.git']);

export class WorkspaceRootError extends Error {
  readonly reason: WorkspaceRootErrorReason;

  constructor(reason: WorkspaceRootErrorReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

function workspaceRootError(reason: WorkspaceRootErrorReason, message: string): WorkspaceRootError {
  return new WorkspaceRootError(reason, message);
}

function validateAbsolutePath(path: string): void {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0') || !isAbsolute(path)) {
    throw workspaceRootError('invalid-path', 'Workspace path must be an absolute path.');
  }
}

function createWorkspaceRoot(path: string, index: number): WorkspaceRoot {
  const home = homedir();
  return {
    id: `root-${index + 1}`,
    label: path === home ? 'Home' : basename(path) || path,
    path,
  };
}

export async function listWorkspaceRoots(): Promise<WorkspaceRoot[]> {
  const configuredPaths = parseWorkspaceRootPaths(process.env.VAMPIRE_WORKSPACE_ROOTS);
  const roots: WorkspaceRoot[] = [];
  const seen = new Set<string>();

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
 */
export async function resolveWorkspaceDirectory(
  cwd: string,
  roots: WorkspaceRoot[]
): Promise<{ root: WorkspaceRoot; path: string }> {
  validateAbsolutePath(cwd);
  const lexicalTarget = resolve(cwd);
  const lexicalRoot = roots
    .filter((root) => pathStaysInside(root.path, lexicalTarget))
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
    .filter((candidate) => pathStaysInside(candidate.path, canonicalTarget))
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

export async function resolveAllowedWorkspaceDirectory(cwd: string): Promise<string> {
  const roots = await listWorkspaceRoots();
  return (await resolveWorkspaceDirectory(cwd, roots)).path;
}

/**
 * Validate an existing stored workspace path without applying the new-root policy.
 * This keeps previously registered workspaces restartable after an allowlist is introduced.
 *
 */
export async function resolveExistingWorkspaceDirectory(cwd: string): Promise<string> {
  validateAbsolutePath(cwd);
  const target = resolve(cwd);
  try {
    const canonicalTarget = await realpath(target);
    if (!(await stat(canonicalTarget)).isDirectory())
      throw workspaceRootError('not-directory', 'Only directories can be used as workspaces.');
    return canonicalTarget;
  } catch (cause) {
    if (cause instanceof WorkspaceRootError) throw cause;
    throw workspaceRootError('not-found', 'Workspace directory is no longer available.');
  }
}

export async function readWorkspaceDirectory(cwd: string | undefined): Promise<WorkspaceDirectoryListing> {
  const roots = await listWorkspaceRoots();
  if (!cwd) {
    return {
      roots,
      current: null,
      parentPath: null,
      directories: [],
      truncated: false,
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
  const directories: WorkspaceDirectoryEntry[] = [];
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
      path: resolved.path,
    },
    parentPath,
    directories,
    truncated,
  };
}
