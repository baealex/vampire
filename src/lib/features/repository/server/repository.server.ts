import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, type Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import {
  copyFile,
  cp,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { errorHasCode, pathStaysInside } from '~/lib/server/path-policy.ts';
import type {
  RepositoryChange,
  RepositoryCommitDiff,
  RepositoryCommitPage,
  RepositoryDiff,
  RepositoryDirectoryListing,
  RepositoryDiscardResult,
  RepositorySnapshot,
  WorkspaceEntryKind,
  WorkspaceFile,
  WorkspaceMoveConflict,
  WorkspaceMoveResult,
  WorkspaceUploadConflict,
  WorkspaceUploadResult,
} from '~/lib/shared/contracts/repository.ts';
import { RepositoryReadError, repositoryError } from './repository-errors.server.ts';
import {
  DEFAULT_COMMIT_PAGE_SIZE,
  gitHeadExists,
  isGitRepositoryAt,
  MAX_COMMIT_PAGE_SIZE,
  normalizeCommitPageValue,
  readGitBranch,
  readGitBranches,
  readGitChanges,
  readGitCommitPage,
  readGitIgnoredPaths,
  readGitSnapshot,
  readGitWorktreeCount,
  readGitWorktrees,
  readRepositoryChangeStats,
  repositoryChangesMatch,
  runGit,
  TEMPORARY_UPLOAD_PREFIX,
} from './repository-git.server.ts';

export type { RepositoryReadErrorReason } from './repository-errors.server.ts';
export { RepositoryReadError } from './repository-errors.server.ts';

export interface RepositorySummary {
  isGitRepository: boolean;
  changeCount: number;
  worktreeCount: number;
  branch?: string;
}

export interface RepositoryWatchPaths {
  root: string;
  gitDirectory?: string;
  worktreesDirectory?: string;
}

export interface WorkspaceImageMetadata {
  path: string;
  mimeType: string;
  size: number;
  modifiedAt: number;
  version: string;
}

export interface WorkspaceImage extends Omit<WorkspaceImageMetadata, 'modifiedAt'> {
  bytes: Buffer;
}

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_DIRECTORY_ENTRY_COUNT = 8_000;
const MAX_DIFF_OUTPUT_BYTES = 2 * 1024 * 1024;
const IGNORED_WORKSPACE_DIRECTORIES = new Set(['.git']);
const COMMIT_HASH_PATTERN = /^[0-9a-f]{7,64}$/iu;

function normalizeRelativePath(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || isAbsolute(value)) {
    throw repositoryError('invalid-path', 'File path must stay inside the workspace.');
  }

  const normalized = normalize(value);
  if (normalized === '.' || normalized === '..' || normalized.startsWith(`..${sep}`) || isAbsolute(normalized)) {
    throw repositoryError('invalid-path', 'File path must stay inside the workspace.');
  }
  return normalized.split(sep).join('/');
}

async function workspaceRoot(cwd: string): Promise<string> {
  try {
    return await realpath(cwd);
  } catch {
    throw repositoryError('not-found', 'Workspace directory is no longer available.');
  }
}

export async function isGitRepository(cwd: string): Promise<boolean> {
  return isGitRepositoryAt(cwd);
}

export async function readRepositoryCommits(
  cwd: string,
  offset = 0,
  limit = DEFAULT_COMMIT_PAGE_SIZE
): Promise<RepositoryCommitPage> {
  const root = await workspaceRoot(cwd);
  if (!(await isGitRepository(root))) {
    throw repositoryError('not-git', 'This workspace is not a Git repository.');
  }
  const normalizedOffset = normalizeCommitPageValue(offset, 0, Number.MAX_SAFE_INTEGER);
  const normalizedLimit = normalizeCommitPageValue(limit, DEFAULT_COMMIT_PAGE_SIZE, MAX_COMMIT_PAGE_SIZE);
  return readGitCommitPage(root, normalizedOffset, normalizedLimit || DEFAULT_COMMIT_PAGE_SIZE);
}

/**
 * Restore one changed path to HEAD. Untracked entries are removed only through
 * Git's own clean eligibility check; tracked paths restore both index and worktree.
 */
export async function discardRepositoryChange(
  cwd: string,
  path: string,
  expected?: RepositoryChange
): Promise<RepositoryDiscardResult> {
  const root = await workspaceRoot(cwd);
  const normalizedPath = normalizeRelativePath(path);
  if (pathContainsGitMetadata(normalizedPath)) {
    throw repositoryError('invalid-path', 'Git metadata changes cannot be discarded here.');
  }
  if (!(await isGitRepository(root))) {
    throw repositoryError('not-git', 'This workspace is not a Git repository.');
  }

  const changes = await readGitChanges(root);
  const change = changes.find((candidate) => candidate.path === normalizedPath);
  if (!change) throw repositoryError('not-found', 'This path no longer has changes to discard.');
  if (expected && !repositoryChangesMatch(change, expected)) {
    throw repositoryError('conflict', 'This Git change was updated. Review it again before discarding.');
  }

  if (change.status === '??') {
    await runGit(root, ['clean', '-f', '--', normalizedPath]);
  } else {
    const restorePaths = [normalizedPath];
    if (change.status.includes('R') && change.previousPath) {
      const previousPath = normalizeRelativePath(change.previousPath);
      if (pathContainsGitMetadata(previousPath)) {
        throw repositoryError('invalid-path', 'Git metadata changes cannot be discarded here.');
      }
      restorePaths.push(previousPath);
    }
    if (await gitHeadExists(root)) {
      await runGit(root, ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...restorePaths]);
    } else {
      await runGit(root, ['rm', '-f', '--', ...restorePaths]);
    }
  }

  const remaining = await readGitChanges(root);
  if (remaining.some((candidate) => candidate.path === normalizedPath)) {
    throw repositoryError('command-failed', 'Git could not completely discard this change.');
  }
  return { path: normalizedPath, untracked: change.status === '??' };
}

/**
 */
async function resolveReadableDirectory(
  cwd: string,
  path: string
): Promise<{ normalizedPath: string; target: string }> {
  const root = await workspaceRoot(cwd);
  const normalizedPath = path === '' ? '' : normalizeRelativePath(path);
  const lexicalTarget = resolve(root, normalizedPath || '.');
  if (!pathStaysInside(root, lexicalTarget)) {
    throw repositoryError('invalid-path', 'Directory path must stay inside the workspace.');
  }

  let target: string;
  try {
    target = await realpath(lexicalTarget);
  } catch {
    throw repositoryError('not-found', 'Directory is no longer available.');
  }
  if (!pathStaysInside(root, target)) {
    throw repositoryError('invalid-path', 'Linked directories outside the workspace cannot be opened.');
  }

  let details;
  try {
    details = await stat(target);
  } catch {
    throw repositoryError('not-found', 'Directory is no longer available.');
  }
  if (!details.isDirectory()) throw repositoryError('unsupported-file', 'Only directories can be opened.');
  return { normalizedPath, target };
}

/**
 * Read only the immediate children of a workspace directory.
 */
export async function readWorkspaceDirectory(cwd: string, path = ''): Promise<RepositoryDirectoryListing> {
  const { normalizedPath, target } = await resolveReadableDirectory(cwd, path);
  let entries;
  try {
    entries = await readdir(target, { withFileTypes: true });
  } catch {
    throw repositoryError('command-failed', 'The directory could not be read.');
  }
  entries.sort((left, right) => {
    if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1;
    return left.name.localeCompare(right.name, 'en');
  });

  const files: string[] = [];
  const directories: string[] = [];
  let truncated = false;
  for (const entry of entries) {
    if (
      entry.isSymbolicLink() ||
      IGNORED_WORKSPACE_DIRECTORIES.has(entry.name) ||
      entry.name.startsWith(TEMPORARY_UPLOAD_PREFIX)
    )
      continue;
    if (files.length + directories.length >= MAX_DIRECTORY_ENTRY_COUNT) {
      truncated = true;
      break;
    }
    const entryPath = normalizedPath ? `${normalizedPath}/${entry.name}` : entry.name;
    if (entry.isDirectory()) directories.push(entryPath);
    else if (entry.isFile()) files.push(entryPath);
  }

  return { files, directories, ignored: [], truncated };
}

const pendingRepositoryDirectories = new Map<string, Promise<RepositoryDirectoryListing>>();

export function readRepositoryDirectory(cwd: string, path = ''): Promise<RepositoryDirectoryListing> {
  const key = JSON.stringify([cwd, path]);
  const pending = pendingRepositoryDirectories.get(key);
  if (pending) return pending;
  const reading = buildRepositoryDirectory(cwd, path).finally(() => pendingRepositoryDirectories.delete(key));
  pendingRepositoryDirectories.set(key, reading);
  return reading;
}

async function buildRepositoryDirectory(cwd: string, path: string): Promise<RepositoryDirectoryListing> {
  const root = await workspaceRoot(cwd);
  const directory = await readWorkspaceDirectory(root, path);
  if (!(await isGitRepository(root))) return directory;
  return {
    ...directory,
    ignored: await readGitIgnoredPaths(root, [...directory.directories, ...directory.files]),
  };
}

const pendingRepositorySnapshots = new Map<string, Promise<RepositorySnapshot>>();

export function readRepositorySnapshot(
  cwd: string,
  commitLimit = DEFAULT_COMMIT_PAGE_SIZE
): Promise<RepositorySnapshot> {
  const limit = normalizeCommitPageValue(commitLimit, DEFAULT_COMMIT_PAGE_SIZE, MAX_COMMIT_PAGE_SIZE);
  const key = JSON.stringify([cwd, limit]);
  const pending = pendingRepositorySnapshots.get(key);
  if (pending) return pending;
  const reading = buildRepositorySnapshot(cwd, limit).finally(() => {
    pendingRepositorySnapshots.delete(key);
  });
  pendingRepositorySnapshots.set(key, reading);
  return reading;
}

async function buildRepositorySnapshot(
  cwd: string,
  commitLimit = DEFAULT_COMMIT_PAGE_SIZE
): Promise<RepositorySnapshot> {
  const root = await workspaceRoot(cwd);
  const gitRepository = await isGitRepository(root);
  const directory = await readWorkspaceDirectory(root);
  if (!gitRepository) {
    return {
      isGitRepository: false,
      files: directory.files,
      directories: directory.directories,
      ignored: [],
      changes: [],
      changeStats: { additions: 0, deletions: 0 },
      truncated: directory.truncated,
    };
  }

  const [changes, ignored, git] = await Promise.all([
    readGitChanges(root),
    readGitIgnoredPaths(root, [...directory.directories, ...directory.files]),
    readGitSnapshot(root, root, normalizeCommitPageValue(commitLimit, DEFAULT_COMMIT_PAGE_SIZE, MAX_COMMIT_PAGE_SIZE)),
  ]);
  return {
    isGitRepository: true,
    git,
    files: directory.files,
    directories: directory.directories,
    ignored,
    changes,
    changeStats: await readRepositoryChangeStats(root, changes),
    truncated: directory.truncated,
  };
}

export async function readRepositorySummary(cwd: string): Promise<RepositorySummary> {
  const root = await workspaceRoot(cwd);
  const gitRepository = await isGitRepository(root);
  if (!gitRepository) return { isGitRepository: false, changeCount: 0, worktreeCount: 0 };
  const [changes, worktreeCount, branch] = await Promise.all([
    readGitChanges(root),
    readGitWorktreeCount(root),
    readGitBranch(root),
  ]);
  return { isGitRepository: true, changeCount: changes.length, worktreeCount, ...(branch ? { branch } : {}) };
}

export async function readRepositoryWatchPaths(cwd: string): Promise<RepositoryWatchPaths> {
  const root = await workspaceRoot(cwd);
  if (!(await isGitRepository(root))) return { root, gitDirectory: undefined };
  const [{ stdout: gitDirectoryOutput }, { stdout: gitCommonDirectoryOutput }] = await Promise.all([
    runGit(root, ['rev-parse', '--absolute-git-dir']),
    runGit(root, ['rev-parse', '--git-common-dir']),
  ]);
  const gitDirectory = gitDirectoryOutput.trim();
  const gitCommonDirectory = gitCommonDirectoryOutput.trim();
  return {
    root,
    gitDirectory: gitDirectory || undefined,
    worktreesDirectory: gitCommonDirectory ? join(resolve(root, gitCommonDirectory), 'worktrees') : undefined,
  };
}

/**
 */
async function resolveReadableFile(
  cwd: string,
  path: string,
  maximumBytes = MAX_FILE_BYTES
): Promise<{
  normalizedPath: string;
  target: string;
  details: Stats;
}> {
  const root = await workspaceRoot(cwd);
  const normalizedPath = normalizeRelativePath(path);
  const lexicalTarget = resolve(root, normalizedPath);
  if (!pathStaysInside(root, lexicalTarget)) {
    throw repositoryError('invalid-path', 'File path must stay inside the workspace.');
  }

  let target: string;
  try {
    target = await realpath(lexicalTarget);
  } catch {
    throw repositoryError('not-found', 'File is no longer available.');
  }
  if (!pathStaysInside(root, target)) {
    throw repositoryError('invalid-path', 'Linked files outside the workspace cannot be opened.');
  }

  let details;
  try {
    details = await stat(target);
  } catch {
    throw repositoryError('not-found', 'File is no longer available.');
  }
  if (!details.isFile()) throw repositoryError('unsupported-file', 'Only regular files can be opened.');
  if (details.size > maximumBytes) {
    throw repositoryError(
      'too-large',
      maximumBytes === MAX_IMAGE_BYTES
        ? 'Images larger than 10 MB are not shown.'
        : 'Files larger than 5 MB are not shown.'
    );
  }
  return { normalizedPath, target, details };
}

/**
 */
async function resolveWritableFile(
  cwd: string,
  path: string,
  existingEntryIsConflict = false
): Promise<
  | { normalizedPath: string; target: string; exists: false }
  | { normalizedPath: string; target: string; exists: true; details: Stats }
> {
  const root = await workspaceRoot(cwd);
  const normalizedPath = normalizeRelativePath(path);
  const lexicalTarget = resolve(root, normalizedPath);
  if (!pathStaysInside(root, lexicalTarget)) {
    throw repositoryError('invalid-path', 'File path must stay inside the workspace.');
  }

  const parent = await resolveWritableDirectory(root, dirname(lexicalTarget));
  const writableTarget = join(parent, basename(lexicalTarget));

  let lexicalDetails;
  try {
    lexicalDetails = await lstat(writableTarget);
  } catch (cause) {
    if (errorHasCode(cause, 'ENOENT')) {
      return { normalizedPath, target: writableTarget, exists: false };
    }
    throw repositoryError('command-failed', 'The file could not be inspected.');
  }

  let target = writableTarget;
  if (lexicalDetails.isSymbolicLink()) {
    try {
      target = await realpath(writableTarget);
    } catch {
      throw repositoryError('invalid-path', 'Linked files outside the workspace cannot be edited.');
    }
    if (!pathStaysInside(root, target)) {
      throw repositoryError('invalid-path', 'Linked files outside the workspace cannot be edited.');
    }
  }

  let details;
  try {
    details = await stat(target);
  } catch {
    throw repositoryError('not-found', 'File is no longer available.');
  }
  if (!details.isFile()) {
    if (existingEntryIsConflict) throw repositoryError('conflict', 'A file or folder with this name already exists.');
    throw repositoryError('unsupported-file', 'Only regular files can be edited.');
  }
  return { normalizedPath, target, exists: true, details };
}

/**
 * Create missing workspace directories without following an unchecked linked parent.
 */
async function resolveWritableDirectory(root: string, directory: string): Promise<string> {
  if (!pathStaysInside(root, directory)) {
    throw repositoryError('invalid-path', 'Directory path must stay inside the workspace.');
  }

  const pathFromRoot = relative(root, directory);
  let current = root;
  for (const segment of pathFromRoot.split(sep).filter(Boolean)) {
    current = join(current, segment);
    let details: Stats;
    try {
      details = await lstat(current);
    } catch (cause) {
      if (!errorHasCode(cause, 'ENOENT')) {
        throw repositoryError('command-failed', 'The directory could not be inspected.');
      }

      let parent;
      try {
        parent = await realpath(dirname(current));
      } catch {
        throw repositoryError('not-found', 'The parent directory is no longer available.');
      }
      if (!pathStaysInside(root, parent)) {
        throw repositoryError('invalid-path', 'Directory path must stay inside the workspace.');
      }

      try {
        await mkdir(current);
        details = await lstat(current);
      } catch (mkdirCause) {
        if (!errorHasCode(mkdirCause, 'EEXIST')) {
          throw repositoryError('command-failed', 'The directory could not be created.');
        }
        try {
          details = await lstat(current);
        } catch {
          throw repositoryError('command-failed', 'The directory could not be inspected.');
        }
      }
    }

    let canonicalDirectory;
    try {
      canonicalDirectory = await realpath(current);
    } catch {
      throw repositoryError('not-found', 'The directory is no longer available.');
    }
    if (!pathStaysInside(root, canonicalDirectory)) {
      throw repositoryError('invalid-path', 'Directory path must stay inside the workspace.');
    }
    if (!details.isDirectory() && !details.isSymbolicLink()) {
      throw repositoryError('unsupported-file', 'Only directories can contain workspace entries.');
    }
    try {
      if (!(await stat(canonicalDirectory)).isDirectory()) {
        throw repositoryError('unsupported-file', 'Only directories can contain workspace entries.');
      }
    } catch (cause) {
      if (cause instanceof RepositoryReadError) throw cause;
      throw repositoryError('command-failed', 'The directory could not be inspected.');
    }
    current = canonicalDirectory;
  }

  return current;
}

function detectImageMimeType(bytes: Uint8Array): string | undefined {
  const prefix = Buffer.from(bytes);
  if (
    prefix.length >= 8 &&
    prefix.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (prefix.length >= 3 && prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff) return 'image/jpeg';
  if (prefix.length >= 6 && ['GIF87a', 'GIF89a'].includes(prefix.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (
    prefix.length >= 12 &&
    prefix.subarray(0, 4).toString('ascii') === 'RIFF' &&
    prefix.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (prefix.length >= 12 && prefix.subarray(4, 8).toString('ascii') === 'ftyp') {
    for (let offset = 8; offset + 4 <= prefix.length; offset += 4) {
      if (['avif', 'avis'].includes(prefix.subarray(offset, offset + 4).toString('ascii'))) return 'image/avif';
    }
  }
  return undefined;
}

function imageVersion(details: Stats): string {
  return createHash('sha256')
    .update(`${details.size}:${details.mtimeMs}:${details.ctimeMs}:${details.ino}`)
    .digest('hex');
}

/**
 */
export async function readWorkspaceImageMetadata(cwd: string, path: string): Promise<WorkspaceImageMetadata> {
  const { normalizedPath, target, details } = await resolveReadableFile(cwd, path, MAX_IMAGE_BYTES);
  const handle = await open(target, 'r');
  const prefix = Buffer.alloc(Math.min(64, details.size));
  try {
    await handle.read(prefix, 0, prefix.length, 0);
  } finally {
    await handle.close();
  }
  const mimeType = detectImageMimeType(prefix);
  if (!mimeType) throw repositoryError('unsupported-file', 'Only PNG, JPEG, GIF, WebP, and AVIF images are previewed.');
  return {
    path: normalizedPath,
    mimeType,
    size: details.size,
    modifiedAt: details.mtimeMs,
    version: imageVersion(details),
  };
}

/**
 */
export async function readWorkspaceImage(cwd: string, path: string): Promise<WorkspaceImage> {
  const { normalizedPath, target, details } = await resolveReadableFile(cwd, path, MAX_IMAGE_BYTES);
  const bytes = await readFile(target);
  if (bytes.length > MAX_IMAGE_BYTES) throw repositoryError('too-large', 'Images larger than 10 MB are not shown.');
  const mimeType = detectImageMimeType(bytes.subarray(0, 64));
  if (!mimeType) throw repositoryError('unsupported-file', 'Only PNG, JPEG, GIF, WebP, and AVIF images are previewed.');
  return {
    path: normalizedPath,
    mimeType,
    bytes,
    size: bytes.length,
    version: imageVersion(details),
  };
}

/**
 */
export async function readWorkspaceFile(cwd: string, path: string): Promise<WorkspaceFile> {
  const { normalizedPath, target, details } = await resolveReadableFile(cwd, path);
  const bytes = await readFile(target);
  if (bytes.length > MAX_FILE_BYTES) throw repositoryError('too-large', 'Files larger than 5 MB are not shown.');
  if (bytes.includes(0)) throw repositoryError('unsupported-file', 'Binary files are not shown.');

  let content;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw repositoryError('unsupported-file', 'Only UTF-8 text files are shown.');
  }

  return {
    path: normalizedPath,
    content,
    size: bytes.length,
    modifiedAt: details.mtimeMs,
    version: createHash('sha256').update(bytes).digest('hex'),
  };
}

/**
 */
export async function writeWorkspaceFile(
  cwd: string,
  path: string,
  content: string,
  options: { expectedVersion?: string; createOnly?: boolean } = {}
): Promise<WorkspaceFile> {
  if (typeof content !== 'string') throw repositoryError('unsupported-file', 'Only UTF-8 text files can be saved.');
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.length > MAX_FILE_BYTES) throw repositoryError('too-large', 'Files larger than 5 MB cannot be saved.');
  if (bytes.includes(0)) throw repositoryError('unsupported-file', 'Binary files are not supported.');

  const resolved = await resolveWritableFile(cwd, path);
  if (options.createOnly && resolved.exists) {
    throw repositoryError('conflict', 'A file with this name already exists.');
  }
  if (options.expectedVersion !== undefined) {
    if (!resolved.exists) throw repositoryError('conflict', 'This file was removed before it could be saved.');
    const current = await readWorkspaceFile(cwd, resolved.normalizedPath);
    if (current.version !== options.expectedVersion) {
      throw repositoryError('conflict', 'This file changed elsewhere. Reload it before saving.');
    }
  }

  try {
    await writeFile(resolved.target, bytes, options.createOnly ? { flag: 'wx' } : undefined);
  } catch (cause) {
    if (options.createOnly && errorHasCode(cause, 'EEXIST')) {
      throw repositoryError('conflict', 'A file with this name already exists.');
    }
    throw repositoryError('command-failed', 'The file could not be saved.');
  }
  return readWorkspaceFile(cwd, resolved.normalizedPath);
}

function ensureUploadPathIsAllowed(path: string): string {
  const normalizedPath = normalizeRelativePath(path);
  if (pathContainsGitMetadata(normalizedPath)) {
    throw repositoryError('invalid-path', 'Git metadata cannot be added.');
  }
  return normalizedPath;
}

function pathContainsGitMetadata(path: string): boolean {
  return path.split('/').some((segment) => segment.toLowerCase() === '.git');
}

function uploadConflictPath(path: string, index: number): string {
  const extension = extname(path);
  const stem = extension ? path.slice(0, -extension.length) : path;
  return `${stem} (${index})${extension}`;
}

async function resolveNewUploadTarget(
  cwd: string,
  path: string
): Promise<{
  normalizedPath: string;
  target: string;
  parent: string;
}> {
  const root = await workspaceRoot(cwd);
  const normalizedPath = ensureUploadPathIsAllowed(path);
  const lexicalTarget = resolve(root, normalizedPath);
  if (!pathStaysInside(root, lexicalTarget)) {
    throw repositoryError('invalid-path', 'File path must stay inside the workspace.');
  }
  const parent = await resolveWritableDirectory(root, dirname(lexicalTarget));
  return { normalizedPath, target: join(parent, basename(lexicalTarget)), parent };
}

async function writeUploadChunk(handle: FileHandle, chunk: Uint8Array): Promise<number> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset, null);
    if (bytesWritten <= 0) throw new Error('The file write stopped before it completed.');
    offset += bytesWritten;
  }
  return offset;
}

async function writeUploadContent(
  handle: FileHandle,
  content: Uint8Array | ReadableStream<Uint8Array>
): Promise<number> {
  if (!('getReader' in content)) return writeUploadChunk(handle, content);
  const reader = content.getReader();
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return size;
      if (value?.byteLength) size += await writeUploadChunk(handle, value);
    }
  } finally {
    reader.releaseLock();
  }
}

async function writeTemporaryUpload(
  parent: string,
  content: Uint8Array | ReadableStream<Uint8Array>,
  mode = 0o600
): Promise<{ path: string; size: number }> {
  const path = join(parent, `${TEMPORARY_UPLOAD_PREFIX}${randomUUID()}`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, 'wx', 0o600);
    const size = await writeUploadContent(handle, content);
    await handle.chmod(mode);
    await handle.sync();
    return { path, size };
  } catch (cause) {
    await handle?.close().catch(() => undefined);
    handle = undefined;
    await unlink(path).catch(() => undefined);
    throw cause;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function linkTemporaryUpload(source: string, target: string): Promise<void> {
  try {
    await link(source, target);
  } catch (cause) {
    if (errorHasCode(cause, 'EEXIST')) {
      throw repositoryError('conflict', 'A file or folder with this name already exists.');
    }
    throw repositoryError('command-failed', 'The file could not be added.');
  }
}

/**
 * Save one browser-uploaded file. Uploads default to create-only so replacing
 * workspace data always requires an explicit conflict policy.
 */
export async function uploadWorkspaceFile(
  cwd: string,
  path: string,
  content: Uint8Array | ReadableStream<Uint8Array>,
  options: { conflict?: WorkspaceUploadConflict } = {}
): Promise<WorkspaceUploadResult> {
  const conflict = options.conflict ?? 'reject';
  const requested = await resolveNewUploadTarget(cwd, path);
  let destinationTarget = requested.target;
  let destinationMode = 0o600;
  if (conflict === 'overwrite') {
    const writable = await resolveWritableFile(cwd, requested.normalizedPath);
    destinationTarget = writable.target;
    if (writable.exists) destinationMode = writable.details.mode & 0o777;
  }
  const temporary = await writeTemporaryUpload(dirname(destinationTarget), content, destinationMode).catch((cause) => {
    if (cause instanceof RepositoryReadError) throw cause;
    throw repositoryError('command-failed', 'The file could not be added.');
  });

  try {
    if (conflict === 'overwrite') {
      try {
        await rename(temporary.path, destinationTarget);
      } catch {
        throw repositoryError('command-failed', 'The file could not be replaced.');
      }
      return { path: requested.normalizedPath, size: temporary.size, renamed: false };
    }

    const maximumAttempts = conflict === 'rename' ? 10_000 : 0;
    for (let index = 0; index <= maximumAttempts; index += 1) {
      const candidatePath =
        index === 0 ? requested.normalizedPath : uploadConflictPath(requested.normalizedPath, index);
      const candidateTarget = join(requested.parent, basename(candidatePath));
      try {
        await linkTemporaryUpload(temporary.path, candidateTarget);
        return {
          path: candidatePath,
          size: temporary.size,
          renamed: candidatePath !== requested.normalizedPath,
        };
      } catch (cause) {
        if (conflict === 'rename' && cause instanceof RepositoryReadError && cause.reason === 'conflict') continue;
        throw cause;
      }
    }
    throw repositoryError('conflict', 'A unique name could not be found for this file.');
  } finally {
    await unlink(temporary.path).catch(() => undefined);
  }
}

async function resolveMovableEntry(
  cwd: string,
  path: string,
  kind: WorkspaceEntryKind
): Promise<{
  normalizedPath: string;
  target: string;
  canonicalTarget: string;
}> {
  const root = await workspaceRoot(cwd);
  const normalizedPath = normalizeRelativePath(path);
  if (pathContainsGitMetadata(normalizedPath)) {
    throw repositoryError('invalid-path', 'Git metadata cannot be moved.');
  }
  const target = resolve(root, normalizedPath);
  if (!pathStaysInside(root, target) || target === root) {
    throw repositoryError('invalid-path', 'Only entries inside the workspace can be moved.');
  }

  let parent;
  try {
    parent = await realpath(dirname(target));
  } catch {
    throw repositoryError('not-found', 'The entry is no longer available.');
  }
  if (!pathStaysInside(root, parent)) {
    throw repositoryError('invalid-path', 'Linked entries outside the workspace cannot be moved.');
  }

  let details;
  try {
    details = await lstat(target);
  } catch (cause) {
    if (errorHasCode(cause, 'ENOENT')) throw repositoryError('not-found', 'The entry is no longer available.');
    throw repositoryError('command-failed', 'The entry could not be inspected.');
  }
  if (details.isSymbolicLink())
    throw repositoryError('invalid-path', 'Linked entries cannot be moved from the workspace.');
  if (kind === 'file' && !details.isFile())
    throw repositoryError('unsupported-file', 'Only files can be moved from this action.');
  if (kind === 'directory' && !details.isDirectory())
    throw repositoryError('unsupported-file', 'Only folders can be moved from this action.');

  let canonicalTarget;
  try {
    canonicalTarget = await realpath(target);
  } catch {
    throw repositoryError('not-found', 'The entry is no longer available.');
  }
  if (!pathStaysInside(root, canonicalTarget)) {
    throw repositoryError('invalid-path', 'Linked entries outside the workspace cannot be moved.');
  }
  return { normalizedPath, target, canonicalTarget };
}

function moveConflictPath(path: string, index: number, kind: WorkspaceEntryKind): string {
  if (kind === 'directory') return `${path} (${index})`;
  return uploadConflictPath(path, index);
}

function workspaceEntryName(value: string): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\0')
  ) {
    throw repositoryError('invalid-path', 'Use a single file or folder name.');
  }
  return value;
}

async function moveEntryToTarget(source: string, target: string, kind: WorkspaceEntryKind): Promise<void> {
  if (kind === 'file') {
    try {
      await link(source, target);
    } catch (cause) {
      if (errorHasCode(cause, 'EEXIST'))
        throw repositoryError('conflict', 'A file or folder with this name already exists.');
      throw repositoryError('command-failed', 'The file could not be moved.');
    }
    try {
      await unlink(source);
    } catch {
      await unlink(target).catch(() => undefined);
      throw repositoryError('command-failed', 'The file could not be moved.');
    }
    return;
  }

  try {
    await mkdir(target);
  } catch (cause) {
    if (errorHasCode(cause, 'EEXIST'))
      throw repositoryError('conflict', 'A file or folder with this name already exists.');
    throw repositoryError('command-failed', 'The folder destination could not be reserved.');
  }
  try {
    await rename(source, target);
  } catch {
    await rmdir(target).catch(() => undefined);
    throw repositoryError('command-failed', 'The folder could not be moved.');
  }
}

/**
 * Move a regular workspace entry into another workspace directory. A target
 * name is reserved before the source is removed so conflicts never overwrite.
 */
export async function moveWorkspaceEntry(
  cwd: string,
  path: string,
  kind: WorkspaceEntryKind,
  targetDirectory: string,
  options: { conflict?: WorkspaceMoveConflict; targetName?: string } = {}
): Promise<WorkspaceMoveResult> {
  const source = await resolveMovableEntry(cwd, path, kind);
  const normalizedTargetDirectory = targetDirectory === '' ? '' : normalizeRelativePath(targetDirectory);
  if (normalizedTargetDirectory && pathContainsGitMetadata(normalizedTargetDirectory)) {
    throw repositoryError('invalid-path', 'Entries cannot be moved into Git metadata.');
  }
  const targetDirectoryEntry = await resolveReadableDirectory(cwd, normalizedTargetDirectory);
  if (kind === 'directory' && pathStaysInside(source.canonicalTarget, targetDirectoryEntry.target)) {
    throw repositoryError('invalid-path', 'A folder cannot be moved into itself.');
  }

  const sourceName =
    options.targetName === undefined ? basename(source.normalizedPath) : workspaceEntryName(options.targetName);
  const requestedPath = normalizedTargetDirectory ? `${normalizedTargetDirectory}/${sourceName}` : sourceName;
  if (pathContainsGitMetadata(requestedPath)) {
    throw repositoryError('invalid-path', 'Entries cannot be renamed to Git metadata.');
  }
  const requestedTarget = join(targetDirectoryEntry.target, sourceName);
  if (source.canonicalTarget === requestedTarget) {
    return { fromPath: source.normalizedPath, path: source.normalizedPath, kind, renamed: false };
  }

  const conflict = options.conflict ?? 'reject';
  const maximumAttempts = conflict === 'rename' ? 10_000 : 0;
  for (let index = 0; index <= maximumAttempts; index += 1) {
    const candidatePath = index === 0 ? requestedPath : moveConflictPath(requestedPath, index, kind);
    const candidateName = basename(candidatePath);
    try {
      await moveEntryToTarget(source.target, join(targetDirectoryEntry.target, candidateName), kind);
      return {
        fromPath: source.normalizedPath,
        path: candidatePath,
        kind,
        renamed: candidatePath !== requestedPath,
      };
    } catch (cause) {
      if (conflict === 'rename' && cause instanceof RepositoryReadError && cause.reason === 'conflict') continue;
      throw cause;
    }
  }
  throw repositoryError('conflict', 'A unique name could not be found for this move.');
}

async function copyEntryToTarget(source: string, target: string, kind: WorkspaceEntryKind): Promise<void> {
  if (kind === 'file') {
    try {
      await copyFile(source, target, fsConstants.COPYFILE_EXCL);
      return;
    } catch (cause) {
      if (errorHasCode(cause, 'EEXIST'))
        throw repositoryError('conflict', 'A file or folder with this name already exists.');
      await unlink(target).catch(() => undefined);
      throw repositoryError('command-failed', 'The file could not be copied.');
    }
  }

  try {
    await mkdir(target);
  } catch (cause) {
    if (errorHasCode(cause, 'EEXIST'))
      throw repositoryError('conflict', 'A file or folder with this name already exists.');
    throw repositoryError('command-failed', 'The folder destination could not be reserved.');
  }
  try {
    for (const entry of await readdir(source)) {
      await cp(join(source, entry), join(target, entry), {
        recursive: true,
        force: false,
        errorOnExist: true,
        preserveTimestamps: true,
      });
    }
  } catch {
    await rm(target, { recursive: true, force: true }).catch(() => undefined);
    throw repositoryError('command-failed', 'The folder could not be copied.');
  }
}

/** Copy a regular workspace entry while preserving its source. */
export async function copyWorkspaceEntry(
  cwd: string,
  path: string,
  kind: WorkspaceEntryKind,
  targetDirectory: string,
  options: { conflict?: WorkspaceMoveConflict } = {}
): Promise<WorkspaceMoveResult> {
  const source = await resolveMovableEntry(cwd, path, kind);
  const normalizedTargetDirectory = targetDirectory === '' ? '' : normalizeRelativePath(targetDirectory);
  if (normalizedTargetDirectory && pathContainsGitMetadata(normalizedTargetDirectory)) {
    throw repositoryError('invalid-path', 'Entries cannot be copied into Git metadata.');
  }
  const targetDirectoryEntry = await resolveReadableDirectory(cwd, normalizedTargetDirectory);
  if (kind === 'directory' && pathStaysInside(source.canonicalTarget, targetDirectoryEntry.target)) {
    throw repositoryError('invalid-path', 'A folder cannot be copied into itself.');
  }

  const sourceName = basename(source.normalizedPath);
  const requestedPath = normalizedTargetDirectory ? `${normalizedTargetDirectory}/${sourceName}` : sourceName;
  const conflict = options.conflict ?? 'reject';
  const maximumAttempts = conflict === 'rename' ? 10_000 : 0;
  for (let index = 0; index <= maximumAttempts; index += 1) {
    const candidatePath = index === 0 ? requestedPath : moveConflictPath(requestedPath, index, kind);
    try {
      await copyEntryToTarget(source.target, join(targetDirectoryEntry.target, basename(candidatePath)), kind);
      return {
        fromPath: source.normalizedPath,
        path: candidatePath,
        kind,
        renamed: candidatePath !== requestedPath,
      };
    } catch (cause) {
      if (conflict === 'rename' && cause instanceof RepositoryReadError && cause.reason === 'conflict') continue;
      throw cause;
    }
  }
  throw repositoryError('conflict', 'A unique name could not be found for this copy.');
}

/**
 */
export async function createWorkspaceDirectory(cwd: string, path: string): Promise<{ path: string }> {
  const root = await workspaceRoot(cwd);
  const normalizedPath = normalizeRelativePath(path);
  const lexicalTarget = resolve(root, normalizedPath);
  if (!pathStaysInside(root, lexicalTarget)) {
    throw repositoryError('invalid-path', 'Folder path must stay inside the workspace.');
  }
  const parent = await resolveWritableDirectory(root, dirname(lexicalTarget));
  const target = join(parent, basename(lexicalTarget));

  try {
    await lstat(target);
    throw repositoryError('conflict', 'A file or folder with this name already exists.');
  } catch (cause) {
    if (cause instanceof RepositoryReadError) throw cause;
    if (!errorHasCode(cause, 'ENOENT')) {
      throw repositoryError('command-failed', 'The folder could not be inspected.');
    }
  }

  try {
    await mkdir(target);
  } catch (cause) {
    if (errorHasCode(cause, 'EEXIST')) {
      throw repositoryError('conflict', 'A file or folder with this name already exists.');
    }
    throw repositoryError('command-failed', 'The folder could not be created.');
  }
  return { path: normalizedPath };
}

/**
 */
export async function deleteWorkspaceEntry(
  cwd: string,
  path: string,
  kind: 'file' | 'directory'
): Promise<{ path: string }> {
  const source = await resolveMovableEntry(cwd, path, kind);

  try {
    if (kind === 'directory') await rm(source.target, { recursive: true, force: false });
    else await unlink(source.target);
  } catch {
    throw repositoryError('command-failed', `The ${kind === 'directory' ? 'folder' : 'file'} could not be deleted.`);
  }
  return { path: source.normalizedPath };
}

/**
 */
export async function readRepositoryDiff(cwd: string, path: string): Promise<RepositoryDiff> {
  const root = await workspaceRoot(cwd);
  const normalizedPath = normalizeRelativePath(path);
  if (!(await isGitRepository(root))) {
    throw repositoryError('not-git', 'This workspace is not a Git repository.');
  }

  const changes = await readGitChanges(root);
  const change = changes.find((candidate) => candidate.path === normalizedPath);
  if (!change) return { path: normalizedPath, sections: [] };

  const commonDiffArguments = ['--no-ext-diff', '--no-textconv', '--no-color', '--unified=3'];
  const sections: RepositoryDiff['sections'] = [];
  if (change.status === '??') {
    const { stdout } = await runGit(
      root,
      ['diff', '--no-index', ...commonDiffArguments, '--', '/dev/null', normalizedPath],
      { acceptedExitCodes: [0, 1], maxBuffer: MAX_DIFF_OUTPUT_BYTES }
    );
    if (stdout) sections.push({ kind: 'untracked', patch: stdout });
    return { path: normalizedPath, sections };
  }

  if (change.status[0] !== ' ' && change.status[0] !== '?') {
    const { stdout } = await runGit(root, ['diff', '--cached', ...commonDiffArguments, '--', normalizedPath], {
      maxBuffer: MAX_DIFF_OUTPUT_BYTES,
    });
    if (stdout) sections.push({ kind: 'staged', patch: stdout });
  }
  if (change.status[1] !== ' ' && change.status[1] !== '?') {
    const { stdout } = await runGit(root, ['diff', ...commonDiffArguments, '--', normalizedPath], {
      maxBuffer: MAX_DIFF_OUTPUT_BYTES,
    });
    if (stdout) sections.push({ kind: 'working', patch: stdout });
  }
  return { path: normalizedPath, sections };
}

export async function readRepositoryCommitDiff(cwd: string, hash: string): Promise<RepositoryCommitDiff> {
  const root = await workspaceRoot(cwd);
  if (!COMMIT_HASH_PATTERN.test(hash)) {
    throw repositoryError('invalid-path', 'Commit hash is invalid.');
  }
  if (!(await isGitRepository(root))) {
    throw repositoryError('not-git', 'This workspace is not a Git repository.');
  }

  const { stdout } = await runGit(
    root,
    ['show', '--format=', '--no-ext-diff', '--no-textconv', '--no-color', '--unified=3', hash, '--'],
    { maxBuffer: MAX_DIFF_OUTPUT_BYTES }
  );
  return { hash, patch: stdout };
}

export async function deleteRepositoryBranch(cwd: string, name: string): Promise<{ name: string }> {
  const root = await workspaceRoot(cwd);
  if (!name || name.trim() !== name || name.includes('\0')) {
    throw repositoryError('invalid-path', 'Branch name is invalid.');
  }
  if (!(await isGitRepository(root))) {
    throw repositoryError('not-git', 'This workspace is not a Git repository.');
  }
  const validation = await runGit(root, ['check-ref-format', '--branch', name], { acceptedExitCodes: [0, 1, 128] });
  if (validation.stderr) throw repositoryError('invalid-path', 'Branch name is invalid.');

  const currentBranch = await readGitBranch(root);
  const worktrees = await readGitWorktrees(root, root);
  const branches = await readGitBranches(root, currentBranch, worktrees, root);
  const branch = branches.find((candidate) => candidate.name === name);
  if (!branch) throw repositoryError('not-found', 'This branch no longer exists.');
  if (branch.worktreePath) {
    throw repositoryError('conflict', 'A branch checked out in a worktree cannot be deleted.');
  }

  await runGit(root, ['branch', '--delete', '--force', '--', name]);
  return { name };
}
