import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { isAbsolute, join, posix, resolve } from 'node:path';
import {
  atomicWriteFile,
  durableUnlink,
  ensurePrivateDirectory,
  errorHasFileCode,
  syncDirectory,
} from './atomic-file.ts';
import {
  createWorkspacePersistenceDocuments,
  parseWorkspacePersistenceDocuments,
} from '../shared/contracts/workspace-persistence.ts';
import { parseWorkspaceStore, type WorkspaceStore } from '../shared/contracts/workspace-store.ts';
import {
  VAMPIRE_GLOBAL_DIRECTORY,
  VAMPIRE_GLOBAL_LAUNCH_PROFILES_FILE,
  VAMPIRE_GLOBAL_SETTINGS_FILE,
  VAMPIRE_REGISTRY_FILE,
  VAMPIRE_WORKSPACE_AUTOMATIONS_FILE,
  VAMPIRE_WORKSPACE_BACKGROUND_FILE,
  VAMPIRE_WORKSPACE_COMPOSER_HISTORY_FILE,
  VAMPIRE_WORKSPACE_NOTE_FILE,
  VAMPIRE_WORKSPACE_SETTINGS_FILE,
  VAMPIRE_WORKSPACES_DIRECTORY,
  vampireStateDirectory,
  vampireWorkspaceStateKey,
} from './state-path.ts';

export const WORKSPACE_STATE_TRANSACTION_FILE = '.workspace-state-transaction.json';
const WORKSPACE_STATE_TRANSACTION_VERSION = 1;
const MAX_WORKSPACE_STATE_FILE_BYTES = 64 * 1024 * 1024;
const MAX_WORKSPACE_TRANSACTION_CONTENT_BYTES = 96 * 1024 * 1024;
const MAX_WORKSPACE_TRANSACTION_FILE_BYTES = 128 * 1024 * 1024;
const MAX_WORKSPACE_ID_LENGTH = 1_024;
const WORKSPACE_DOCUMENT_NAMES = new Set([
  VAMPIRE_WORKSPACE_SETTINGS_FILE,
  VAMPIRE_WORKSPACE_AUTOMATIONS_FILE,
  VAMPIRE_WORKSPACE_BACKGROUND_FILE,
]);
const GLOBAL_DOCUMENT_NAMES = new Set([VAMPIRE_GLOBAL_SETTINGS_FILE, VAMPIRE_GLOBAL_LAUNCH_PROFILES_FILE]);
const OWNED_WORKSPACE_FILE_NAMES = new Set([
  ...WORKSPACE_DOCUMENT_NAMES,
  VAMPIRE_WORKSPACE_NOTE_FILE,
  VAMPIRE_WORKSPACE_COMPOSER_HISTORY_FILE,
]);

type WorkspaceStateTransactionEntry = {
  path: string;
  sha256: string;
  contents: string;
};

type WorkspaceStateTransaction = {
  version: typeof WORKSPACE_STATE_TRANSACTION_VERSION;
  id: string;
  createdAt: string;
  files: WorkspaceStateTransactionEntry[];
};

const operationQueues = new Map<string, Promise<void>>();

function errorDetail(error: unknown): string {
  return error instanceof Error ? ` ${error.message}` : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function stateDirectory(path?: string): string {
  return resolve(path ?? vampireStateDirectory());
}

function transactionPath(directory: string): string {
  return join(directory, WORKSPACE_STATE_TRANSACTION_FILE);
}

function relativeWorkspaceDocumentPath(workspaceId: string, name: string): string {
  return posix.join(VAMPIRE_WORKSPACES_DIRECTORY, vampireWorkspaceStateKey(workspaceId), name);
}

function isAllowedTransactionPath(path: string): boolean {
  if (
    !path ||
    path.includes('\\') ||
    isAbsolute(path) ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    return false;
  }
  if (path === VAMPIRE_REGISTRY_FILE) return true;
  const parts = path.split('/');
  if (parts.length === 2 && parts[0] === VAMPIRE_GLOBAL_DIRECTORY) {
    return GLOBAL_DOCUMENT_NAMES.has(parts[1]);
  }
  return (
    parts.length === 3 &&
    parts[0] === VAMPIRE_WORKSPACES_DIRECTORY &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(parts[1]) &&
    WORKSPACE_DOCUMENT_NAMES.has(parts[2])
  );
}

async function readRegularFile(path: string, maximumBytes: number, label: string): Promise<string> {
  const details = await lstat(path);
  if (details.isSymbolicLink() || !details.isFile()) throw new Error(`${label} must be a safe regular file.`);
  if (details.size > maximumBytes) throw new Error(`${label} is too large to read safely.`);
  return readFile(path, 'utf8');
}

async function assertSafeDirectory(path: string, label: string): Promise<void> {
  const details = await lstat(path);
  if (details.isSymbolicLink() || !details.isDirectory()) throw new Error(`${label} must be a safe real directory.`);
}

async function ensureSafeParent(directory: string, relativePath: string): Promise<void> {
  await ensurePrivateDirectory(directory);
  const parts = relativePath.split('/').slice(0, -1);
  let current = directory;
  for (const part of parts) {
    current = join(current, part);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (!errorHasFileCode(error, 'EEXIST')) throw error;
    }
    await assertSafeDirectory(current, current);
  }
}

async function assertRegularTargetOrMissing(path: string): Promise<void> {
  try {
    const details = await lstat(path);
    if (details.isSymbolicLink() || !details.isFile()) throw new Error(`${path} is not a safe regular file.`);
  } catch (error) {
    if (!errorHasFileCode(error, 'ENOENT')) throw error;
  }
}

async function readJsonFile(path: string, label: string): Promise<unknown> {
  try {
    return JSON.parse(await readRegularFile(path, MAX_WORKSPACE_STATE_FILE_BYTES, label)) as unknown;
  } catch (error) {
    throw new Error(`${label} is unreadable.${errorDetail(error)}`, { cause: error });
  }
}

function stateFiles(value: WorkspaceStore, revision: string): WorkspaceStateTransactionEntry[] {
  const documents = createWorkspacePersistenceDocuments(value, revision);
  const files: WorkspaceStateTransactionEntry[] = [
    {
      path: posix.join(VAMPIRE_GLOBAL_DIRECTORY, VAMPIRE_GLOBAL_SETTINGS_FILE),
      contents: json(documents.globalSettings),
      sha256: '',
    },
    {
      path: posix.join(VAMPIRE_GLOBAL_DIRECTORY, VAMPIRE_GLOBAL_LAUNCH_PROFILES_FILE),
      contents: json(documents.launchProfiles),
      sha256: '',
    },
    ...documents.workspaces.flatMap((workspace) => [
      {
        path: relativeWorkspaceDocumentPath(workspace.workspaceId, VAMPIRE_WORKSPACE_SETTINGS_FILE),
        contents: json(workspace.settings),
        sha256: '',
      },
      {
        path: relativeWorkspaceDocumentPath(workspace.workspaceId, VAMPIRE_WORKSPACE_AUTOMATIONS_FILE),
        contents: json(workspace.automations),
        sha256: '',
      },
      {
        path: relativeWorkspaceDocumentPath(workspace.workspaceId, VAMPIRE_WORKSPACE_BACKGROUND_FILE),
        contents: json(workspace.background),
        sha256: '',
      },
    ]),
    { path: VAMPIRE_REGISTRY_FILE, contents: json(documents.registry), sha256: '' },
  ];
  return files.map((file) => ({ ...file, sha256: sha256(file.contents) }));
}

function parseTransaction(value: unknown): WorkspaceStateTransaction {
  if (
    !isRecord(value) ||
    value.version !== WORKSPACE_STATE_TRANSACTION_VERSION ||
    typeof value.id !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(value.id) ||
    typeof value.createdAt !== 'string' ||
    !Array.isArray(value.files)
  ) {
    throw new Error('The workspace state transaction is invalid.');
  }
  const createdAt = Date.parse(value.createdAt);
  if (!Number.isFinite(createdAt) || new Date(createdAt).toISOString() !== value.createdAt) {
    throw new Error('The workspace state transaction timestamp is invalid.');
  }
  const files: WorkspaceStateTransactionEntry[] = [];
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const entry of value.files) {
    if (
      !isRecord(entry) ||
      typeof entry.path !== 'string' ||
      !isAllowedTransactionPath(entry.path) ||
      paths.has(entry.path) ||
      typeof entry.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      typeof entry.contents !== 'string' ||
      sha256(entry.contents) !== entry.sha256
    ) {
      throw new Error('The workspace state transaction contains an invalid file.');
    }
    totalBytes += Buffer.byteLength(entry.contents);
    if (totalBytes > MAX_WORKSPACE_TRANSACTION_CONTENT_BYTES) {
      throw new Error('The workspace state transaction is too large.');
    }
    paths.add(entry.path);
    files.push({ path: entry.path, sha256: entry.sha256, contents: entry.contents });
  }
  if (!paths.has(VAMPIRE_REGISTRY_FILE)) throw new Error('The workspace state transaction has no registry commit.');
  return {
    version: WORKSPACE_STATE_TRANSACTION_VERSION,
    id: value.id,
    createdAt: value.createdAt,
    files,
  };
}

async function readTransaction(directory: string): Promise<WorkspaceStateTransaction | undefined> {
  const path = transactionPath(directory);
  try {
    return parseTransaction(
      JSON.parse(await readRegularFile(path, MAX_WORKSPACE_TRANSACTION_FILE_BYTES, path)) as unknown
    );
  } catch (error) {
    if (errorHasFileCode(error, 'ENOENT')) return undefined;
    throw new Error(`Vampire workspace state recovery data is unreadable; refusing to continue.${errorDetail(error)}`, {
      cause: error,
    });
  }
}

async function readStructuredStateWithoutRecovery(directory: string): Promise<WorkspaceStore> {
  await assertSafeDirectory(directory, 'The Vampire state directory');
  const registry = await readJsonFile(join(directory, VAMPIRE_REGISTRY_FILE), VAMPIRE_REGISTRY_FILE);
  if (!isRecord(registry) || !Array.isArray(registry.workspaces)) {
    throw new Error('registry.json does not contain a workspace list.');
  }
  const workspaceIds = registry.workspaces.map((workspace) => {
    if (!isRecord(workspace) || typeof workspace.id !== 'string' || workspace.id.length > MAX_WORKSPACE_ID_LENGTH) {
      throw new Error('registry.json contains an invalid workspace identifier.');
    }
    return workspace.id;
  });
  const workspaces = await Promise.all(
    workspaceIds.map(async (workspaceId) => {
      const directory_ = join(directory, VAMPIRE_WORKSPACES_DIRECTORY, vampireWorkspaceStateKey(workspaceId));
      await assertSafeDirectory(join(directory, VAMPIRE_WORKSPACES_DIRECTORY), VAMPIRE_WORKSPACES_DIRECTORY);
      await assertSafeDirectory(directory_, `${workspaceId} workspace state`);
      return {
        workspaceId,
        settings: await readJsonFile(
          join(directory_, VAMPIRE_WORKSPACE_SETTINGS_FILE),
          `${workspaceId}/${VAMPIRE_WORKSPACE_SETTINGS_FILE}`
        ),
        automations: await readJsonFile(
          join(directory_, VAMPIRE_WORKSPACE_AUTOMATIONS_FILE),
          `${workspaceId}/${VAMPIRE_WORKSPACE_AUTOMATIONS_FILE}`
        ),
        background: await readJsonFile(
          join(directory_, VAMPIRE_WORKSPACE_BACKGROUND_FILE),
          `${workspaceId}/${VAMPIRE_WORKSPACE_BACKGROUND_FILE}`
        ),
      };
    })
  );
  await assertSafeDirectory(join(directory, VAMPIRE_GLOBAL_DIRECTORY), VAMPIRE_GLOBAL_DIRECTORY);
  return parseWorkspacePersistenceDocuments({
    registry,
    globalSettings: await readJsonFile(
      join(directory, VAMPIRE_GLOBAL_DIRECTORY, VAMPIRE_GLOBAL_SETTINGS_FILE),
      `global/${VAMPIRE_GLOBAL_SETTINGS_FILE}`
    ),
    launchProfiles: await readJsonFile(
      join(directory, VAMPIRE_GLOBAL_DIRECTORY, VAMPIRE_GLOBAL_LAUNCH_PROFILES_FILE),
      `global/${VAMPIRE_GLOBAL_LAUNCH_PROFILES_FILE}`
    ),
    workspaces,
  });
}

async function applyTransaction(directory: string, transaction: WorkspaceStateTransaction): Promise<void> {
  const ordered = [...transaction.files].sort((left, right) => {
    if (left.path === VAMPIRE_REGISTRY_FILE) return 1;
    if (right.path === VAMPIRE_REGISTRY_FILE) return -1;
    return left.path.localeCompare(right.path);
  });
  for (const file of ordered) {
    await ensureSafeParent(directory, file.path);
    const path = join(directory, ...file.path.split('/'));
    await assertRegularTargetOrMissing(path);
    await atomicWriteFile(path, file.contents);
    const persisted = await readRegularFile(path, MAX_WORKSPACE_STATE_FILE_BYTES, file.path);
    if (sha256(persisted) !== file.sha256) {
      throw new Error(`Vampire could not verify the committed workspace state file: ${file.path}`);
    }
  }
  await readStructuredStateWithoutRecovery(directory);
}

async function recoverWithoutQueue(directory: string): Promise<boolean> {
  const transaction = await readTransaction(directory);
  if (!transaction) return false;
  await applyTransaction(directory, transaction);
  await durableUnlink(transactionPath(directory));
  return true;
}

async function queued<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  const previous = operationQueues.get(directory) ?? Promise.resolve();
  let release: () => void;
  const current = new Promise<void>((resolve_) => {
    release = resolve_;
  });
  const tail = previous.then(() => current);
  operationQueues.set(directory, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release!();
    if (operationQueues.get(directory) === tail) operationQueues.delete(directory);
  }
}

export async function structuredWorkspaceStateExists(requestedStateDirectory?: string): Promise<boolean> {
  const directory = stateDirectory(requestedStateDirectory);
  for (const path of [transactionPath(directory), join(directory, VAMPIRE_REGISTRY_FILE)]) {
    try {
      const details = await lstat(path);
      if (details.isSymbolicLink() || !details.isFile()) throw new Error(`${path} is not a safe regular file.`);
      return true;
    } catch (error) {
      if (!errorHasFileCode(error, 'ENOENT')) throw error;
    }
  }
  return false;
}

export async function recoverStructuredWorkspaceState(requestedStateDirectory?: string): Promise<boolean> {
  const directory = stateDirectory(requestedStateDirectory);
  return queued(directory, () => recoverWithoutQueue(directory));
}

export async function readStructuredWorkspaceState(requestedStateDirectory?: string): Promise<WorkspaceStore> {
  const directory = stateDirectory(requestedStateDirectory);
  return queued(directory, async () => {
    await recoverWithoutQueue(directory);
    return readStructuredStateWithoutRecovery(directory);
  });
}

export async function writeStructuredWorkspaceState(
  value: WorkspaceStore,
  options: { stateDirectory?: string; revision?: string; now?: number } = {}
): Promise<void> {
  const directory = stateDirectory(options.stateDirectory);
  const state = parseWorkspaceStore(value);
  const revision = options.revision ?? randomUUID();
  const transaction: WorkspaceStateTransaction = {
    version: WORKSPACE_STATE_TRANSACTION_VERSION,
    id: randomUUID(),
    createdAt: new Date(options.now ?? Date.now()).toISOString(),
    files: stateFiles(state, revision),
  };
  parseTransaction(transaction);
  await queued(directory, async () => {
    await recoverWithoutQueue(directory);
    await ensurePrivateDirectory(directory);
    await assertRegularTargetOrMissing(transactionPath(directory));
    await atomicWriteFile(transactionPath(directory), json(transaction));
    await applyTransaction(directory, transaction);
    await durableUnlink(transactionPath(directory));
  });
}

async function assertRemovableWorkspaceDirectory(path: string): Promise<'missing' | 'directory'> {
  try {
    const details = await lstat(path);
    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw new Error(`The workspace state removal path is unsafe: ${path}`);
    }
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (!OWNED_WORKSPACE_FILE_NAMES.has(entry.name) || entry.isSymbolicLink() || !entry.isFile()) {
        throw new Error(`The workspace state directory contains an unexpected entry: ${entry.name}`);
      }
    }
    return 'directory';
  } catch (error) {
    if (errorHasFileCode(error, 'ENOENT')) return 'missing';
    throw error;
  }
}

export async function prepareStructuredWorkspaceStateRemoval(
  workspaceId: string,
  requestedStateDirectory?: string
): Promise<() => Promise<void>> {
  const directory = stateDirectory(requestedStateDirectory);
  if (!(await structuredWorkspaceStateExists(directory))) return async () => undefined;
  const workspaceDirectory = join(directory, VAMPIRE_WORKSPACES_DIRECTORY, vampireWorkspaceStateKey(workspaceId));
  if ((await assertRemovableWorkspaceDirectory(workspaceDirectory)) === 'missing') return async () => undefined;
  return async () => {
    const state = await readStructuredWorkspaceState(directory);
    if (state.workspaces.some((workspace) => workspace.id === workspaceId)) {
      throw new Error('The workspace state directory cannot be removed while it remains registered.');
    }
    if ((await assertRemovableWorkspaceDirectory(workspaceDirectory)) === 'missing') return;
    await rm(workspaceDirectory, { recursive: true });
    await syncDirectory(join(directory, VAMPIRE_WORKSPACES_DIRECTORY));
  };
}
