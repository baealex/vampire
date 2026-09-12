import { execFile as execFileCallback, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type {
  RepositoryBranch,
  RepositoryChange,
  RepositoryChangeStats,
  RepositoryCommit,
  RepositoryCommitPage,
  RepositoryGitSnapshot,
  RepositoryUpstream,
  RepositoryWorktree,
} from '~/lib/shared/contracts/repository.ts';
import { RepositoryReadError, repositoryError } from './repository-errors.server.ts';

interface GitRunOptions {
  acceptedExitCodes?: number[];
  maxBuffer?: number;
  temporaryGitDirectory?: string;
}

type GitCommandError = Error & {
  code?: string | number;
  stdout?: string;
  stderr?: string;
  killed?: boolean;
};

const execFile = promisify(execFileCallback);
const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;
const GIT_TIMEOUT_MS = 8_000;
const MAX_GIT_ERROR_DETAIL_LENGTH = 240;
export const DEFAULT_COMMIT_PAGE_SIZE = 20;
export const MAX_COMMIT_PAGE_SIZE = 100;
export const TEMPORARY_UPLOAD_PREFIX = '.vampire-upload-';

function gitEnvironmentWithoutPathspecModes(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.GIT_LITERAL_PATHSPECS;
  delete environment.GIT_GLOB_PATHSPECS;
  delete environment.GIT_NOGLOB_PATHSPECS;
  return environment;
}

function gitErrorDetail(error: GitCommandError): string | undefined {
  const detail = error.stderr
    ?.split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
  if (!detail) return undefined;
  return detail.length > MAX_GIT_ERROR_DETAIL_LENGTH ? `${detail.slice(0, MAX_GIT_ERROR_DETAIL_LENGTH - 1)}…` : detail;
}

function gitFailureMessage(error: GitCommandError): string {
  const detail = gitErrorDetail(error);
  if (detail) return `Git could not read this workspace: ${detail}`;
  if (error.code === 'ENOENT') return 'Git could not read this workspace: Git is not available on the server.';
  if (error.code === 'EACCES') return 'Git could not read this workspace: Git cannot be executed on the server.';
  return 'Git could not read this workspace.';
}

/**
 */
export async function runGit(
  cwd: string,
  args: string[],
  options: GitRunOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const acceptedExitCodes = options.acceptedExitCodes ?? [0];
  try {
    return await execFile('git', ['-C', cwd, '-c', 'status.relativePaths=true', ...args], {
      encoding: 'utf8',
      maxBuffer: options.maxBuffer ?? MAX_GIT_OUTPUT_BYTES,
      timeout: GIT_TIMEOUT_MS,
      env: {
        ...process.env,
        GIT_LITERAL_PATHSPECS: '1',
        GIT_EXTERNAL_DIFF: '',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_PAGER: 'cat',
        GIT_TERMINAL_PROMPT: '0',
        LC_ALL: 'C',
        ...(options.temporaryGitDirectory
          ? {
              GIT_INDEX_FILE: join(options.temporaryGitDirectory, 'index'),
              GIT_OBJECT_DIRECTORY: join(options.temporaryGitDirectory, 'objects'),
            }
          : {}),
      },
    });
  } catch (error) {
    const commandError = error as GitCommandError;
    if (typeof commandError.code === 'number' && acceptedExitCodes.includes(commandError.code)) {
      return { stdout: commandError.stdout ?? '', stderr: commandError.stderr ?? '' };
    }
    if (commandError.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      throw repositoryError('too-large', 'Repository output is too large to display safely.');
    }
    if (commandError.killed) throw repositoryError('command-failed', 'Git took too long to respond.');
    throw repositoryError('command-failed', gitFailureMessage(commandError));
  }
}

export async function readGitIgnoredPaths(cwd: string, paths: string[]): Promise<string[]> {
  if (paths.length === 0) return [];
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('git', ['-C', cwd, '-c', 'status.relativePaths=true', 'check-ignore', '--stdin', '-z'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...gitEnvironmentWithoutPathspecModes(),
        GIT_OPTIONAL_LOCKS: '0',
        GIT_PAGER: 'cat',
        GIT_TERMINAL_PROMPT: '0',
        LC_ALL: 'C',
      },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const finish = (error?: Error, ignored: string[] = []) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) rejectPromise(error);
      else resolvePromise(ignored);
    };
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish(repositoryError('command-failed', 'Git took too long to respond.'));
    }, GIT_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_GIT_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        finish(repositoryError('too-large', 'Repository output is too large to display safely.'));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error) =>
      finish(repositoryError('command-failed', gitFailureMessage(error as GitCommandError))),
    );
    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0 && code !== 1) {
        const message = Buffer.concat(stderr).toString('utf8').trim();
        finish(
          repositoryError(
            'command-failed',
            gitFailureMessage({ name: 'GitCommandError', message, stderr: message, code: code ?? undefined }),
          ),
        );
        return;
      }
      finish(undefined, Buffer.concat(stdout).toString('utf8').split('\0').filter(Boolean));
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(`${paths.join('\0')}\0`);
  });
}

export async function isGitRepositoryAt(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await runGit(cwd, ['rev-parse', '--is-inside-work-tree'], { acceptedExitCodes: [0, 128] });
    return stdout.trim() === 'true';
  } catch (error) {
    if (error instanceof RepositoryReadError && error.reason === 'command-failed') return false;
    throw error;
  }
}

function countGitWorktrees(output: string): number {
  return output
    .trim()
    .split(/\n\n+/)
    .filter(
      (entry) =>
        entry.split('\n').some((line) => line.startsWith('worktree ')) &&
        !entry.split('\n').some((line) => line.startsWith('prunable ')),
    ).length;
}

export async function readGitWorktreeCount(cwd: string): Promise<number> {
  const { stdout } = await runGit(cwd, ['worktree', 'list', '--porcelain']);
  return countGitWorktrees(stdout);
}

export async function readGitBranch(cwd: string): Promise<string | undefined> {
  const { stdout } = await runGit(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
    acceptedExitCodes: [0, 1, 128],
  });
  return stdout.trim() || undefined;
}

async function readGitUpstream(cwd: string): Promise<RepositoryUpstream | undefined> {
  const { stdout } = await runGit(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], {
    acceptedExitCodes: [0, 128],
  });
  const name = stdout.trim();
  if (!name) return undefined;

  const { stdout: countOutput } = await runGit(cwd, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']);
  const [aheadValue, behindValue] = countOutput.trim().split(/\s+/u);
  const ahead = Number(aheadValue);
  const behind = Number(behindValue);
  if (!Number.isInteger(ahead) || ahead < 0 || !Number.isInteger(behind) || behind < 0) {
    throw repositoryError('command-failed', 'Git returned an unreadable upstream status.');
  }
  return { name, ahead, behind };
}

function parseGitCommits(output: string): RepositoryCommit[] {
  const commits: RepositoryCommit[] = [];
  for (const record of output.split('\x1e')) {
    if (!record) continue;
    const fields = record.split('\0');
    const [hash, shortHash, authorName, authoredAtValue, subject] = fields;
    if (!hash || !shortHash || !authorName || !authoredAtValue) continue;
    const authoredAt = Number(authoredAtValue) * 1_000;
    if (!Number.isFinite(authoredAt)) continue;
    const shortstat = fields.slice(5).join('\0');
    const filesChanged = Number(/(\d+) files? changed/u.exec(shortstat)?.[1] ?? 0);
    const additions = Number(/(\d+) insertions?\(\+\)/u.exec(shortstat)?.[1] ?? 0);
    const deletions = Number(/(\d+) deletions?\(-\)/u.exec(shortstat)?.[1] ?? 0);
    commits.push({
      hash,
      shortHash,
      authorName,
      authoredAt,
      subject,
      stats: { filesChanged, additions, deletions },
    });
  }
  return commits;
}

async function buildGitCommitPage(cwd: string, offset: number, limit: number): Promise<RepositoryCommitPage> {
  if (!(await gitHeadExists(cwd))) return { commits: [], hasMore: false };
  const { stdout } = await runGit(cwd, [
    'log',
    '-z',
    '--shortstat',
    `--skip=${offset}`,
    `--max-count=${limit + 1}`,
    '--format=%x1e%H%x00%h%x00%an%x00%at%x00%s%x00',
  ]);
  const commits = parseGitCommits(stdout);
  return { commits: commits.slice(0, limit), hasMore: commits.length > limit };
}

export function normalizeCommitPageValue(value: number, fallback: number, maximum: number): number {
  if (!Number.isInteger(value) || value < 0) return fallback;
  return Math.min(value, maximum);
}

export async function readGitCommitPage(cwd: string, offset: number, limit: number): Promise<RepositoryCommitPage> {
  return buildGitCommitPage(cwd, offset, limit);
}

function parseGitWorktrees(output: string, root: string): RepositoryWorktree[] {
  const worktrees: RepositoryWorktree[] = [];
  let current: Omit<RepositoryWorktree, 'name' | 'current'> | undefined;
  const finish = () => {
    if (!current) return;
    worktrees.push({
      ...current,
      name: basename(current.path),
      current: resolve(current.path) === root,
    });
    current = undefined;
  };

  for (const field of output.split('\0')) {
    if (field.startsWith('worktree ')) {
      finish();
      current = { path: field.slice('worktree '.length), head: '' };
    } else if (current && field.startsWith('HEAD ')) {
      current.head = field.slice('HEAD '.length);
    } else if (current && field.startsWith('branch refs/heads/')) {
      current.branch = field.slice('branch refs/heads/'.length);
    }
  }
  finish();
  return worktrees.filter(({ head }) => Boolean(head));
}

export async function readGitWorktrees(cwd: string, root: string): Promise<RepositoryWorktree[]> {
  const { stdout } = await runGit(cwd, ['worktree', 'list', '--porcelain', '-z']);
  return parseGitWorktrees(stdout, root);
}

function parseGitBranches(
  output: string,
  currentBranch: string | undefined,
  worktrees: RepositoryWorktree[],
  root: string,
): RepositoryBranch[] {
  const worktreeByBranch = new Map(
    worktrees.flatMap((worktree) => (worktree.branch ? [[worktree.branch, worktree.path] as const] : [])),
  );
  const branches = output
    .split('\n')
    .filter(Boolean)
    .flatMap((line): RepositoryBranch[] => {
      const [name, head, committedAtValue] = line.split('\t');
      if (!name || !head) return [];
      const worktreePath = worktreeByBranch.get(name);
      const committedAt = Number(committedAtValue) * 1_000;
      return [
        {
          name,
          head,
          ...(Number.isFinite(committedAt) && committedAt > 0 ? { committedAt } : {}),
          current: name === currentBranch,
          ...(worktreePath ? { worktreePath } : {}),
        },
      ];
    });

  if (currentBranch && !branches.some(({ name }) => name === currentBranch)) {
    branches.push({ name: currentBranch, current: true, worktreePath: root });
  }
  return branches.sort(
    (left, right) => Number(right.current) - Number(left.current) || left.name.localeCompare(right.name, 'en'),
  );
}

export async function readGitBranches(
  cwd: string,
  currentBranch: string | undefined,
  worktrees: RepositoryWorktree[],
  root: string,
): Promise<RepositoryBranch[]> {
  const { stdout } = await runGit(cwd, [
    'for-each-ref',
    '--format=%(refname:short)%09%(objectname:short)%09%(committerdate:unix)',
    'refs/heads',
  ]);
  return parseGitBranches(stdout, currentBranch, worktrees, root);
}

export async function readGitSnapshot(cwd: string, root: string, commitLimit: number): Promise<RepositoryGitSnapshot> {
  const [branch, upstream, commitPage, worktrees] = await Promise.all([
    readGitBranch(cwd),
    readGitUpstream(cwd),
    readGitCommitPage(cwd, 0, commitLimit),
    readGitWorktrees(cwd, root),
  ]);
  const branches = await readGitBranches(cwd, branch, worktrees, root);
  return {
    ...(branch ? { branch } : {}),
    detached: !branch && commitPage.commits.length > 0,
    ...(upstream ? { upstream } : {}),
    commits: commitPage.commits,
    hasMoreCommits: commitPage.hasMore,
    branches,
    worktrees,
  };
}

function parseGitChanges(output: string): RepositoryChange[] {
  const records = output.split('\0');
  const changes: RepositoryChange[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    if (record.length < 4 || record[2] !== ' ') {
      throw repositoryError('command-failed', 'Git returned an unreadable status.');
    }

    const status = record.slice(0, 2);
    const path = record.slice(3);
    const renamed = status[0] === 'R' || status[0] === 'C' || status[1] === 'R' || status[1] === 'C';
    const previousPath = renamed ? records[++index] : undefined;
    if (path.split('/').some((segment) => segment.startsWith(TEMPORARY_UPLOAD_PREFIX))) continue;
    changes.push({
      path,
      status,
      ...(previousPath ? { previousPath } : {}),
    });
  }
  return changes.sort((left, right) => left.path.localeCompare(right.path, 'en'));
}

const pendingGitChanges = new Map<string, Promise<RepositoryChange[]>>();

export function readGitChanges(cwd: string): Promise<RepositoryChange[]> {
  const pending = pendingGitChanges.get(cwd);
  if (pending) return pending;
  const reading = runGit(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.'])
    .then(({ stdout }) => parseGitChanges(stdout))
    .finally(() => pendingGitChanges.delete(cwd));
  pendingGitChanges.set(cwd, reading);
  return reading;
}

function parseGitNumstat(output: string): RepositoryChangeStats {
  const stats: RepositoryChangeStats = { additions: 0, deletions: 0 };
  for (const line of output.split('\n')) {
    const [additionValue, deletionValue] = line.split('\t');
    const additions = Number(additionValue);
    const deletions = Number(deletionValue);
    if (!Number.isInteger(additions) || additions < 0 || !Number.isInteger(deletions) || deletions < 0) continue;
    stats.additions += additions;
    stats.deletions += deletions;
  }
  return stats;
}

function addRepositoryChangeStats(target: RepositoryChangeStats, source: RepositoryChangeStats) {
  target.additions += source.additions;
  target.deletions += source.deletions;
}

export async function readRepositoryChangeStats(
  cwd: string,
  changes: RepositoryChange[],
): Promise<RepositoryChangeStats> {
  if (changes.length === 0) return { additions: 0, deletions: 0 };

  const stats: RepositoryChangeStats = { additions: 0, deletions: 0 };
  const hasHead = await gitHeadExists(cwd);
  const trackedChanges = changes.some((change) => change.status !== '??');
  if (trackedChanges) {
    const comparison = hasHead ? ['HEAD'] : ['--cached'];
    const { stdout } = await runGit(cwd, ['diff', '--numstat', '--no-renames', ...comparison, '--', '.']);
    addRepositoryChangeStats(stats, parseGitNumstat(stdout));

    // An unborn repository has no HEAD comparison, so include its unstaged diff
    // as well. This follows the staged/working sections shown in the diff viewer.
    if (!hasHead) {
      const { stdout: workingStdout } = await runGit(cwd, ['diff', '--numstat', '--no-renames', '--', '.']);
      addRepositoryChangeStats(stats, parseGitNumstat(workingStdout));
    }
  }

  // Build intent-to-add entries in an isolated index. Git can then count all
  // new files in one diff, retaining attributes and binary detection. Neither
  // the user's index nor their object database is written.
  const untracked = changes.filter((change) => change.status === '??');
  if (untracked.length > 0) {
    const temporaryGitDirectory = await mkdtemp(join(tmpdir(), 'vampire-git-stats-'));
    try {
      await mkdir(join(temporaryGitDirectory, 'objects'));
      const pathspec = join(temporaryGitDirectory, 'paths');
      await writeFile(pathspec, `${untracked.map((change) => change.path).join('\0')}\0`);
      await runGit(
        cwd,
        [
          '-c',
          'core.splitIndex=false',
          'add',
          '--intent-to-add',
          `--pathspec-from-file=${pathspec}`,
          '--pathspec-file-nul',
        ],
        {
          temporaryGitDirectory,
        },
      );
      const { stdout } = await runGit(cwd, ['diff', '--numstat', '--no-renames', '--', '.'], {
        temporaryGitDirectory,
      });
      addRepositoryChangeStats(stats, parseGitNumstat(stdout));
    } finally {
      await rm(temporaryGitDirectory, { recursive: true, force: true });
    }
  }
  return stats;
}

export async function gitHeadExists(cwd: string): Promise<boolean> {
  const { stdout } = await runGit(cwd, ['rev-parse', '--verify', 'HEAD'], { acceptedExitCodes: [0, 128] });
  return Boolean(stdout.trim());
}

export function repositoryChangesMatch(left: RepositoryChange, right: RepositoryChange): boolean {
  return left.path === right.path && left.status === right.status && left.previousPath === right.previousPath;
}
