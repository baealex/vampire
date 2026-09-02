import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { CURRENT_STATE_LAYOUT_VERSION, runStateMigrations } from './state-migrations.ts';

export const DEVELOPMENT_STATE_MARKER_FILE = '.vampire-development-state.json';
const DEVELOPMENT_STATE_MARKER_VERSION = 1;
const DEVELOPMENT_STATE_MARKER_KIND = 'vampire-development-state';
const MAX_DEVELOPMENT_STATE_COPY_BYTES = 256 * 1024 * 1024;
const MAX_ONLINE_SNAPSHOT_ATTEMPTS = 5;
const TMUX_SOCKET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

type DevelopmentStateFile = {
  path: string;
  bytes: number;
  sha256: string;
};

type DevelopmentStateMarker = {
  version: typeof DEVELOPMENT_STATE_MARKER_VERSION;
  kind: typeof DEVELOPMENT_STATE_MARKER_KIND;
  stateDirectory: string;
  sourceFingerprint: string;
  createdAt: string;
  layoutVersion: number;
  files: DevelopmentStateFile[];
};

type SnapshotFile = DevelopmentStateFile & {
  content: Buffer;
};

class DevelopmentStateChangedError extends Error {}

function errorHasCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException)?.code === code;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizedRelativePath(path: string): string {
  return path.split(sep).join('/');
}

function pathStaysInside(parent: string, child: string): boolean {
  const childPath = relative(parent, child);
  return childPath === '' || (!childPath.startsWith(`..${sep}`) && childPath !== '..' && !isAbsolute(childPath));
}

function pathsOverlap(left: string, right: string): boolean {
  return pathStaysInside(left, right) || pathStaysInside(right, left);
}

async function canonicalPotentialPath(path: string): Promise<string> {
  const requested = resolve(path);
  try {
    return await realpath(requested);
  } catch (error) {
    if (!errorHasCode(error, 'ENOENT')) throw error;
    const parent = dirname(requested);
    if (parent === requested) return requested;
    return join(await canonicalPotentialPath(parent), basename(requested));
  }
}

async function assertDirectory(path: string, label: string): Promise<string> {
  let details;
  try {
    details = await lstat(path);
  } catch (error) {
    if (errorHasCode(error, 'ENOENT')) throw new Error(`${label} does not exist: ${path}`);
    throw error;
  }
  if (details.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link: ${path}`);
  if (!details.isDirectory()) throw new Error(`${label} is not a directory: ${path}`);
  return realpath(path);
}

function isDurableRootFile(name: string): boolean {
  return (
    name === 'sessions.json' ||
    name === 'registry.json' ||
    name === 'state-layout.json' ||
    name === 'status-plugins.json' ||
    name === 'terminal-input-settings.json' ||
    name.endsWith('.note.md')
  );
}

function isDurableStateDirectory(name: string): boolean {
  return name === 'composer-history' || name === 'global' || name === 'workspaces';
}

function isDurableNestedFile(relativePath: string): boolean {
  if (relativePath.startsWith('composer-history/')) return relativePath.endsWith('.json');
  if (relativePath.startsWith('global/')) return relativePath.endsWith('.json');
  if (!relativePath.startsWith('workspaces/')) return false;
  const parts = normalizedRelativePath(relativePath).split('/');
  return (
    parts.length === 3 &&
    ['settings.json', 'automations.json', 'background.json', 'composer-history.json', 'note.md'].includes(parts[2]!)
  );
}

async function readSnapshotFile(root: string, path: string): Promise<SnapshotFile> {
  const absolutePath = join(root, path);
  let before;
  try {
    before = await lstat(absolutePath);
  } catch (error) {
    if (errorHasCode(error, 'ENOENT')) {
      throw new DevelopmentStateChangedError(`Vampire state changed while it was being copied: ${path}`);
    }
    throw error;
  }
  if (before.isSymbolicLink()) {
    throw new Error(`Vampire refused to copy a symbolic link from development state: ${path}`);
  }
  if (!before.isFile()) throw new Error(`Vampire development state contains a non-file entry: ${path}`);
  let content;
  try {
    content = await readFile(absolutePath);
  } catch (error) {
    if (errorHasCode(error, 'ENOENT')) {
      throw new DevelopmentStateChangedError(`Vampire state changed while it was being copied: ${path}`);
    }
    throw error;
  }
  let after;
  try {
    after = await lstat(absolutePath);
  } catch (error) {
    if (errorHasCode(error, 'ENOENT')) {
      throw new DevelopmentStateChangedError(`Vampire state changed while it was being copied: ${path}`);
    }
    throw error;
  }
  if (
    after.isSymbolicLink() ||
    !after.isFile() ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    content.byteLength !== after.size
  ) {
    throw new DevelopmentStateChangedError(`Vampire state changed while it was being copied: ${path}`);
  }
  return {
    path: normalizedRelativePath(path),
    bytes: content.byteLength,
    sha256: sha256(content),
    content,
  };
}

async function collectDurableDirectoryFiles(
  root: string,
  directory: string,
  relativeDirectory: string
): Promise<SnapshotFile[]> {
  const files: SnapshotFile[] = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (errorHasCode(error, 'ENOENT')) {
      throw new DevelopmentStateChangedError(`Vampire state changed while it was being copied: ${relativeDirectory}`);
    }
    throw error;
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = join(relativeDirectory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Vampire refused to copy a symbolic link from development state: ${relativePath}`);
    }
    if (entry.isDirectory()) {
      files.push(...(await collectDurableDirectoryFiles(root, join(directory, entry.name), relativePath)));
      continue;
    }
    if (entry.isFile() && isDurableNestedFile(normalizedRelativePath(relativePath))) {
      files.push(await readSnapshotFile(root, relativePath));
    }
  }
  return files;
}

async function collectDevelopmentStateFiles(sourceDirectory: string): Promise<SnapshotFile[]> {
  const files: SnapshotFile[] = [];
  for (const entry of (await readdir(sourceDirectory, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name)
  )) {
    if (isDurableStateDirectory(entry.name)) {
      if (entry.isSymbolicLink()) {
        throw new Error(`Vampire refused to copy a symbolic link from development state: ${entry.name}`);
      }
      if (!entry.isDirectory()) throw new Error(`The ${entry.name} state path is not a directory.`);
      files.push(
        ...(await collectDurableDirectoryFiles(sourceDirectory, join(sourceDirectory, entry.name), entry.name))
      );
      continue;
    }
    if (!isDurableRootFile(entry.name)) continue;
    if (entry.isSymbolicLink()) {
      throw new Error(`Vampire refused to copy a symbolic link from development state: ${entry.name}`);
    }
    if (!entry.isFile()) throw new Error(`Vampire development state contains a non-file entry: ${entry.name}`);
    files.push(await readSnapshotFile(sourceDirectory, entry.name));
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  if (!files.some((file) => file.path === 'sessions.json' || file.path === 'registry.json')) {
    throw new Error('The source directory does not contain a Vampire workspace registry.');
  }
  const totalBytes = files.reduce((total, file) => total + file.bytes, 0);
  if (totalBytes > MAX_DEVELOPMENT_STATE_COPY_BYTES) {
    throw new Error('The durable Vampire state is too large to copy into a development directory.');
  }
  return files;
}

function manifestFiles(files: readonly SnapshotFile[]): DevelopmentStateFile[] {
  return files.map(({ path, bytes, sha256: digest }) => ({ path, bytes, sha256: digest }));
}

function equalFileManifests(left: readonly SnapshotFile[], right: readonly SnapshotFile[]): boolean {
  return JSON.stringify(manifestFiles(left)) === JSON.stringify(manifestFiles(right));
}

function isDevelopmentStateFile(value: unknown): value is DevelopmentStateFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const file = value as Record<string, unknown>;
  if (
    typeof file.path !== 'string' ||
    file.path.includes('\\') ||
    file.path.startsWith('/') ||
    file.path.split('/').some((part) => part === '' || part === '.' || part === '..') ||
    !Number.isSafeInteger(file.bytes) ||
    (file.bytes as number) < 0 ||
    typeof file.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(file.sha256)
  ) {
    return false;
  }
  return file.path.includes('/') ? isDurableNestedFile(file.path) : isDurableRootFile(file.path);
}

function isDevelopmentStateMarker(value: unknown): value is DevelopmentStateMarker {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const marker = value as Record<string, unknown>;
  if (
    marker.version === DEVELOPMENT_STATE_MARKER_VERSION &&
    marker.kind === DEVELOPMENT_STATE_MARKER_KIND &&
    typeof marker.stateDirectory === 'string' &&
    isAbsolute(marker.stateDirectory) &&
    typeof marker.sourceFingerprint === 'string' &&
    /^[a-f0-9]{64}$/.test(marker.sourceFingerprint) &&
    typeof marker.createdAt === 'string' &&
    Number.isSafeInteger(marker.layoutVersion) &&
    (marker.layoutVersion as number) >= 1 &&
    (marker.layoutVersion as number) <= CURRENT_STATE_LAYOUT_VERSION &&
    Array.isArray(marker.files)
  ) {
    const createdAt = Date.parse(marker.createdAt);
    if (!Number.isFinite(createdAt) || new Date(createdAt).toISOString() !== marker.createdAt) return false;
    let previousPath = '';
    let totalBytes = 0;
    let includesRegistry = false;
    for (const file of marker.files) {
      if (!isDevelopmentStateFile(file) || file.path <= previousPath) return false;
      previousPath = file.path;
      totalBytes += file.bytes;
      if (totalBytes > MAX_DEVELOPMENT_STATE_COPY_BYTES) return false;
      if (file.path === 'sessions.json' || file.path === 'registry.json') includesRegistry = true;
    }
    return includesRegistry;
  }
  return false;
}

export type PrepareDevelopmentStateCopyOptions = {
  sourceDirectory: string;
  targetDirectory: string;
  maximumAttempts?: number;
  now?: number;
  beforeSourceVerification?: (attempt: number) => Promise<void> | void;
};

export type PreparedDevelopmentStateCopy = {
  stateDirectory: string;
  fileCount: number;
  attempts: number;
  layoutVersion: number;
  totalBytes: number;
};

export async function prepareDevelopmentStateCopy(
  options: PrepareDevelopmentStateCopyOptions
): Promise<PreparedDevelopmentStateCopy> {
  const sourceDirectory = await assertDirectory(resolve(options.sourceDirectory), 'The source state directory');
  const requestedTarget = resolve(options.targetDirectory);
  try {
    await lstat(requestedTarget);
    throw new Error(`The development target must not already exist: ${requestedTarget}`);
  } catch (error) {
    if (!errorHasCode(error, 'ENOENT')) throw error;
  }

  await mkdir(dirname(requestedTarget), { recursive: true, mode: 0o700 });
  const targetDirectory = join(await realpath(dirname(requestedTarget)), basename(requestedTarget));
  if (pathsOverlap(sourceDirectory, targetDirectory)) {
    throw new Error('The source and development target directories must not overlap.');
  }

  const maximumAttempts = options.maximumAttempts ?? MAX_ONLINE_SNAPSHOT_ATTEMPTS;
  if (!Number.isSafeInteger(maximumAttempts) || maximumAttempts < 1 || maximumAttempts > 20) {
    throw new Error('The online snapshot attempt limit must be between 1 and 20.');
  }

  let lastChange: Error | undefined;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    let stagingDirectory: string | undefined;
    try {
      const files = await collectDevelopmentStateFiles(sourceDirectory);
      stagingDirectory = join(dirname(targetDirectory), `.${basename(targetDirectory)}.${randomUUID()}.staging`);
      await mkdir(stagingDirectory, { mode: 0o700 });
      for (const file of files) {
        const destination = join(stagingDirectory, file.path);
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        await writeFile(destination, file.content, { mode: 0o600, flag: 'wx' });
      }

      const verifiedTarget = await collectDevelopmentStateFiles(stagingDirectory);
      if (!equalFileManifests(files, verifiedTarget)) {
        throw new Error('The development snapshot failed byte verification.');
      }
      await options.beforeSourceVerification?.(attempt);
      const verifiedSource = await collectDevelopmentStateFiles(sourceDirectory);
      if (!equalFileManifests(files, verifiedSource)) {
        throw new DevelopmentStateChangedError('Vampire state changed during the online snapshot.');
      }

      const preparedAt = options.now ?? Date.now();
      await Promise.all([
        mkdir(join(stagingDirectory, 'agent-support', 'guides'), { recursive: true, mode: 0o700 }),
        mkdir(join(stagingDirectory, 'agent-support', 'requests', 'automations'), {
          recursive: true,
          mode: 0o700,
        }),
      ]);
      const migration = await runStateMigrations({ stateDirectory: stagingDirectory, now: () => preparedAt });
      const marker: DevelopmentStateMarker = {
        version: DEVELOPMENT_STATE_MARKER_VERSION,
        kind: DEVELOPMENT_STATE_MARKER_KIND,
        stateDirectory: targetDirectory,
        sourceFingerprint: sha256(sourceDirectory),
        createdAt: new Date(preparedAt).toISOString(),
        layoutVersion: migration.layoutVersion,
        files: manifestFiles(files),
      };
      await writeFile(join(stagingDirectory, DEVELOPMENT_STATE_MARKER_FILE), `${JSON.stringify(marker, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      try {
        await lstat(targetDirectory);
        throw new Error(`The development target must not already exist: ${targetDirectory}`);
      } catch (error) {
        if (!errorHasCode(error, 'ENOENT')) throw error;
      }
      await rename(stagingDirectory, targetDirectory);
      stagingDirectory = undefined;
      return {
        stateDirectory: targetDirectory,
        fileCount: files.length,
        attempts: attempt,
        layoutVersion: migration.layoutVersion,
        totalBytes: files.reduce((total, file) => total + file.bytes, 0),
      };
    } catch (error) {
      if (stagingDirectory) await rm(stagingDirectory, { recursive: true, force: true });
      if (error instanceof DevelopmentStateChangedError) {
        lastChange = error;
        continue;
      }
      throw error;
    }
  }
  throw new Error(
    `Vampire state kept changing across ${maximumAttempts} online snapshot attempts; no development target was created.`,
    { cause: lastChange }
  );
}

export type PrepareDevelopmentEnvironmentOptions = {
  homeDirectory?: string;
};

export type PreparedDevelopmentEnvironment = {
  stateDirectory: string;
  tmuxSocketName: string;
};

export async function prepareDevelopmentEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  options: PrepareDevelopmentEnvironmentOptions = {}
): Promise<PreparedDevelopmentEnvironment> {
  const requestedStateDirectory = env.VAMPIRE_STATE_DIR?.trim();
  if (!requestedStateDirectory) {
    throw new Error(
      'VAMPIRE_STATE_DIR is required for development. Prepare a marked development copy instead of using ~/.vampire.'
    );
  }

  const stateDirectory = await assertDirectory(resolve(requestedStateDirectory), 'The development state directory');
  const productionStateDirectory = await canonicalPotentialPath(join(options.homeDirectory ?? homedir(), '.vampire'));
  if (pathsOverlap(stateDirectory, productionStateDirectory)) {
    throw new Error('The development server refuses to use or contain the production state directory.');
  }

  const markerPath = join(stateDirectory, DEVELOPMENT_STATE_MARKER_FILE);
  let markerDetails;
  try {
    markerDetails = await lstat(markerPath);
  } catch (error) {
    if (errorHasCode(error, 'ENOENT')) {
      throw new Error(`The development state marker is missing: ${markerPath}`);
    }
    throw error;
  }
  if (!markerDetails.isFile() || markerDetails.isSymbolicLink() || markerDetails.size > 1024 * 1024) {
    throw new Error(`The development state marker is invalid: ${markerPath}`);
  }
  let markerValue: unknown;
  try {
    markerValue = JSON.parse(await readFile(markerPath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`The development state marker is unreadable: ${markerPath}`, { cause: error });
  }
  if (!isDevelopmentStateMarker(markerValue) || markerValue.stateDirectory !== stateDirectory) {
    throw new Error(`The development state marker is invalid for this directory: ${markerPath}`);
  }

  const tmuxSocketName = `vampire-dev-${sha256(stateDirectory).slice(0, 16)}`;
  if (!TMUX_SOCKET_NAME_PATTERN.test(tmuxSocketName)) throw new Error('The development tmux socket name is invalid.');
  env.VAMPIRE_STATE_DIR = stateDirectory;
  env.VAMPIRE_TMUX_SOCKET_NAME = tmuxSocketName;
  env.VAMPIRE_SAFE_DEVELOPMENT = '1';
  return { stateDirectory, tmuxSocketName };
}
