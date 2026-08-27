import { execFile as execFileCallback } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { errorHasCode, pathStaysInside } from '~/lib/server/path-policy.ts';
import { vampireStatePath } from '~/lib/server/state-path.ts';

export const WORKTREE_LABEL_MAX_LENGTH = 80;

export type GitWorktreeErrorReason = 'invalid-name' | 'not-git' | 'no-head' | 'invalid-location' | 'command-failed';

export class GitWorktreeError extends Error {
  readonly reason: GitWorktreeErrorReason;

  constructor(reason: GitWorktreeErrorReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

export interface CreatedGitWorktree {
  cwd: string;
  label: string;
  branch: string;
  sourceRoot: string;
  managedRoot: string;
  workspaceDirectory: string;
}

type CreateGitWorktreeOptions = {
  managedRoot?: string;
  id?: string;
};

export interface ManagedGitWorktree {
  id: string;
  cwd: string;
  repositoryPath?: string;
}

type RemoveManagedGitWorktreeOptions = {
  managedRoot?: string;
};

type GitCommandError = Error & {
  code?: string | number;
  stdout?: string;
  stderr?: string;
  killed?: boolean;
};

const execFile = promisify(execFileCallback);
const GIT_TIMEOUT_MS = 60_000;
const MAX_GIT_OUTPUT_BYTES = 1024 * 1024;
const CREATION_ID_PATTERN = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

type GitOperation = 'create' | 'remove';

function worktreeError(reason: GitWorktreeErrorReason, message: string): GitWorktreeError {
  return new GitWorktreeError(reason, message);
}

function normalizeLabel(value: string): string {
  const label = typeof value === 'string' ? value.trim().replace(/\s+/gu, ' ') : '';
  if (!label || label.length > WORKTREE_LABEL_MAX_LENGTH || /[\0-\x1f\x7f]/u.test(label)) {
    throw worktreeError(
      'invalid-name',
      `Task name must be a single line between 1 and ${WORKTREE_LABEL_MAX_LENGTH} characters.`
    );
  }
  return label;
}

function slugify(value: string): string {
  return (
    value
      .normalize('NFKD')
      .replace(/\p{Mark}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/g, '') || 'task'
  );
}

function creationId(value: string | undefined): string {
  const id = value ?? randomUUID();
  if (!CREATION_ID_PATTERN.test(id)) {
    throw worktreeError('command-failed', 'Vampire could not allocate an isolated workspace ID.');
  }
  return id.toLowerCase();
}

async function runGit(
  cwd: string,
  args: string[],
  acceptedExitCodes: number[] = [0],
  operation: GitOperation = 'create'
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFile('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      timeout: GIT_TIMEOUT_MS,
      env: {
        ...process.env,
        GIT_EXTERNAL_DIFF: '',
        GIT_PAGER: 'cat',
        GIT_TERMINAL_PROMPT: '0',
        LC_ALL: 'C',
      },
    });
  } catch (error) {
    const commandError = error as GitCommandError;
    if (typeof commandError.code === 'number' && acceptedExitCodes.includes(commandError.code)) {
      return { stdout: commandError.stdout ?? '', stderr: commandError.stderr ?? '' };
    }
    if (commandError.killed) {
      throw worktreeError(
        'command-failed',
        operation === 'remove'
          ? 'Git took too long to remove the managed working copy.'
          : 'Git took too long to create the isolated workspace.'
      );
    }
    throw worktreeError(
      'command-failed',
      operation === 'remove'
        ? 'Git could not remove the managed working copy.'
        : 'Git could not create the isolated workspace.'
    );
  }
}

async function canonicalLocation(input: string): Promise<{ path: string; exists: boolean }> {
  let current = resolve(input);
  const missingSegments: string[] = [];

  while (true) {
    try {
      const existingPath = await realpath(current);
      return {
        path: join(existingPath, ...missingSegments.reverse()),
        exists: missingSegments.length === 0,
      };
    } catch (error) {
      if (!errorHasCode(error, 'ENOENT') && !errorHasCode(error, 'ENOTDIR')) {
        throw worktreeError('command-failed', 'Vampire could not inspect the managed working copy.');
      }
      const parent = dirname(current);
      if (parent === current) {
        throw worktreeError('command-failed', 'Vampire could not inspect the managed working copy.');
      }
      missingSegments.push(basename(current));
      current = parent;
    }
  }
}

function listedWorktreePaths(output: string): string[] {
  return output
    .split('\0')
    .filter((field) => field.startsWith('worktree '))
    .map((field) => resolve(field.slice('worktree '.length)));
}

async function repositoryDetails(cwd: string): Promise<{ sourceRoot: string; commonDirectory: string }> {
  let canonicalCwd: string;
  try {
    canonicalCwd = await realpath(cwd);
  } catch {
    throw worktreeError('not-git', 'The source workspace directory is no longer available.');
  }

  const inside = await runGit(canonicalCwd, ['rev-parse', '--is-inside-work-tree'], [0, 128]);
  if (inside.stdout.trim() !== 'true') {
    throw worktreeError('not-git', 'Isolated workspaces require a Git working tree.');
  }
  const head = await runGit(canonicalCwd, ['rev-parse', '--verify', 'HEAD'], [0, 128]);
  if (!head.stdout.trim()) {
    throw worktreeError('no-head', 'Create the repository’s first commit before making an isolated workspace.');
  }

  const [rootResult, commonDirectoryResult] = await Promise.all([
    runGit(canonicalCwd, ['rev-parse', '--show-toplevel']),
    runGit(canonicalCwd, ['rev-parse', '--git-common-dir']),
  ]);
  const sourceRoot = await realpath(rootResult.stdout.trim());
  const commonDirectory = await realpath(resolve(canonicalCwd, commonDirectoryResult.stdout.trim()));
  return { sourceRoot, commonDirectory };
}

async function cleanupCreatedWorktree(worktree: CreatedGitWorktree, removeBranch = true): Promise<void> {
  if (!pathStaysInside(worktree.managedRoot, worktree.cwd)) return;
  await runGit(worktree.sourceRoot, ['worktree', 'remove', '--force', worktree.cwd]).catch(() => undefined);
  await rm(worktree.workspaceDirectory, { recursive: true, force: true }).catch(() => undefined);
  if (removeBranch) {
    await runGit(worktree.sourceRoot, ['branch', '-D', worktree.branch]).catch(() => undefined);
  }
}

export async function createGitWorktree(
  cwd: string,
  name: string,
  options: CreateGitWorktreeOptions = {}
): Promise<CreatedGitWorktree> {
  const label = normalizeLabel(name);
  const id = creationId(options.id);
  const suffix = id.slice(0, 8);
  const slug = slugify(label);
  const { sourceRoot, commonDirectory } = await repositoryDetails(cwd);
  const requestedManagedRoot = resolve(options.managedRoot ?? join(dirname(vampireStatePath()), 'worktrees'));
  await mkdir(requestedManagedRoot, { recursive: true, mode: 0o700 });
  const managedRoot = await realpath(requestedManagedRoot);
  if (pathStaysInside(sourceRoot, managedRoot)) {
    throw worktreeError(
      'invalid-location',
      'VAMPIRE_STATE_DIR must be outside the source Git working tree to create isolated workspaces.'
    );
  }

  const repositoryName =
    (basename(commonDirectory) === '.git' ? basename(dirname(commonDirectory)) : basename(sourceRoot)) || 'repository';
  const workspaceDirectory = join(managedRoot, id);
  await mkdir(workspaceDirectory, { recursive: true, mode: 0o700 });

  const branch = `${slug}-${suffix}`;
  const target = join(workspaceDirectory, repositoryName);
  const created: CreatedGitWorktree = {
    cwd: target,
    label,
    branch,
    sourceRoot,
    managedRoot,
    workspaceDirectory,
  };

  let branchCreated = false;
  try {
    await runGit(sourceRoot, ['branch', branch, 'HEAD']);
    branchCreated = true;
    await runGit(sourceRoot, ['worktree', 'add', '--quiet', target, branch]);
    return created;
  } catch (error) {
    await cleanupCreatedWorktree(created, branchCreated);
    throw error;
  }
}

export async function rollbackGitWorktree(worktree: CreatedGitWorktree): Promise<void> {
  await cleanupCreatedWorktree(worktree);
}

/**
 * Removes only a worktree created inside Vampire's UUID-scoped managed root.
 * The Git branch is intentionally preserved so committed work remains recoverable.
 */
export async function removeManagedGitWorktree(
  worktree: ManagedGitWorktree,
  options: RemoveManagedGitWorktreeOptions = {}
): Promise<void> {
  const id = creationId(worktree.id);
  const requestedManagedRoot = resolve(options.managedRoot ?? join(dirname(vampireStatePath()), 'worktrees'));
  const managedRoot = (await canonicalLocation(requestedManagedRoot)).path;
  const workspaceDirectory = join(managedRoot, id);
  const targetLocation = await canonicalLocation(worktree.cwd);

  if (dirname(targetLocation.path) !== workspaceDirectory) {
    throw worktreeError(
      'invalid-location',
      'Vampire refused to remove a working copy outside its managed worktree directory.'
    );
  }

  let gitCwd: string | undefined;
  if (worktree.repositoryPath?.trim()) {
    const repositoryLocation = await canonicalLocation(worktree.repositoryPath);
    if (repositoryLocation.exists) gitCwd = repositoryLocation.path;
  }
  if (!gitCwd && targetLocation.exists) gitCwd = targetLocation.path;
  if (!gitCwd) {
    throw worktreeError(
      'command-failed',
      'The source Git repository is unavailable, so Vampire could not clear the managed worktree registration.'
    );
  }

  const before = await runGit(gitCwd, ['worktree', 'list', '--porcelain', '-z'], [0], 'remove');
  if (listedWorktreePaths(before.stdout).includes(targetLocation.path)) {
    await runGit(gitCwd, ['worktree', 'remove', '--force', targetLocation.path], [0], 'remove');
    const after = await runGit(gitCwd, ['worktree', 'list', '--porcelain', '-z'], [0], 'remove');
    if (listedWorktreePaths(after.stdout).includes(targetLocation.path)) {
      throw worktreeError('command-failed', 'Git kept the managed worktree registration.');
    }
  }

  try {
    await rm(workspaceDirectory, { recursive: true, force: true });
  } catch {
    throw worktreeError('command-failed', 'Vampire could not delete the managed working copy.');
  }
}
