import { createHash, randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { lstat, mkdir, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, posix } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  DEFAULT_WORKSPACE_COMPOSER_HISTORY_SETTINGS,
  isWorkspaceComposerHistorySettings,
  isWorkspaceComposerPrompt,
  MAX_WORKSPACE_COMPOSER_PROMPTS,
  normalizeWorkspaceComposerPromptHistory,
  type WorkspaceComposerPrompt,
} from '../../shared/contracts/workspace-composer-history.ts';
import {
  defaultStatusPlugins,
  isStatusPluginList,
  STATUS_PLUGIN_CPU_COMMAND,
  STATUS_PLUGIN_MEMORY_COMMAND,
} from '../../shared/contracts/status-plugin.ts';
import { DEFAULT_TERMINAL_INPUT_SETTINGS, isTerminalInputSettings } from '../../shared/contracts/terminal-input.ts';
import { parseWorkspaceStore, type WorkspaceStore } from '../../shared/contracts/workspace-store.ts';
import { atomicWriteFile, ensurePrivateDirectory, errorHasFileCode, syncDirectory } from '../atomic-file.ts';
import {
  VAMPIRE_AGENT_GUIDES_DIRECTORY,
  VAMPIRE_AGENT_REQUESTS_DIRECTORY,
  VAMPIRE_AGENT_SUPPORT_DIRECTORY,
  VAMPIRE_GLOBAL_COMPOSER_HISTORY_FILE,
  VAMPIRE_GLOBAL_DIRECTORY,
  VAMPIRE_GLOBAL_LAUNCH_PROFILES_FILE,
  VAMPIRE_GLOBAL_SETTINGS_FILE,
  VAMPIRE_GLOBAL_STATUS_WIDGETS_FILE,
  VAMPIRE_GLOBAL_TERMINAL_INPUT_FILE,
  VAMPIRE_LEGACY_STATE_FILE,
  VAMPIRE_REGISTRY_FILE,
  VAMPIRE_WORKSPACE_COMPOSER_HISTORY_FILE,
  VAMPIRE_WORKSPACE_AUTOMATIONS_FILE,
  VAMPIRE_WORKSPACE_BACKGROUND_FILE,
  VAMPIRE_WORKSPACE_NOTE_FILE,
  VAMPIRE_WORKSPACE_SETTINGS_FILE,
  VAMPIRE_WORKSPACES_DIRECTORY,
  vampireWorkspaceStateKey,
} from '../state-path.ts';
import {
  readStructuredWorkspaceState,
  structuredWorkspaceStateExists,
  writeStructuredWorkspaceState,
} from '../workspace-state-files.ts';
import type { StateMigrationContext, StateMigrationSource } from './types.ts';

export const ORGANIZED_STATE_MIGRATION_NAME = '0001-organize-state-directory';
export const ORGANIZED_STATE_BACKUP_DIRECTORY = posix.join('backups', ORGANIZED_STATE_MIGRATION_NAME);
export const ORGANIZED_STATE_BACKUP_MANIFEST = 'manifest.json';
const STATE_LAYOUT_FILE = 'state-layout.json';
const ORGANIZED_STATE_STAGING_DIRECTORY = '.state-migration-0001.staging';
const BACKUP_FORMAT_VERSION = 1;
const MAX_BACKUP_FILE_BYTES = 64 * 1024 * 1024;
const MAX_BACKUP_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_NOTE_BYTES = 128 * 1024;
const LEGACY_DIRECTORY_NAMES = new Set(['composer-history', 'agent-guides', 'automation-requests']);
const LEGACY_ROOT_FILE_NAMES = new Set([
  VAMPIRE_LEGACY_STATE_FILE,
  STATE_LAYOUT_FILE,
  'status-plugins.json',
  'terminal-input-settings.json',
  'sessions.json.before-note-files.bak',
]);

type SnapshotFile = {
  path: string;
  bytes: number;
  sha256: string;
  mode: 0o600 | 0o700;
  contents: Buffer;
};

type BackupManifest = {
  version: typeof BACKUP_FORMAT_VERSION;
  migration: typeof ORGANIZED_STATE_MIGRATION_NAME;
  createdAt: string;
  files: Array<Omit<SnapshotFile, 'contents'>>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function absoluteFromRelative(root: string, relativePath: string): string {
  return join(root, ...relativePath.split('/'));
}

function isSafeRelativePath(path: string): boolean {
  return (
    Boolean(path) &&
    !path.includes('\\') &&
    !path.startsWith('/') &&
    path.split('/').every((part) => Boolean(part) && part !== '.' && part !== '..')
  );
}

function isLegacySnapshotPath(path: string): boolean {
  if (!isSafeRelativePath(path)) return false;
  const parts = path.split('/');
  if (parts.length === 1) {
    return LEGACY_ROOT_FILE_NAMES.has(path) || path.endsWith('.note.md');
  }
  return LEGACY_DIRECTORY_NAMES.has(parts[0]!);
}

function snapshotMode(mode: number): 0o600 | 0o700 {
  return mode & 0o111 ? 0o700 : 0o600;
}

async function assertExistingSafeDirectoryChain(root: string, relativeDirectory = ''): Promise<void> {
  let current = root;
  const rootDetails = await lstat(current);
  if (rootDetails.isSymbolicLink() || !rootDetails.isDirectory()) {
    throw new Error(`State path is not a safe directory: ${current}`);
  }
  for (const part of relativeDirectory.split('/').filter(Boolean)) {
    current = join(current, part);
    const details = await lstat(current);
    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw new Error(`State path is not a safe directory: ${current}`);
    }
  }
}

async function readStableFile(root: string, relativePath: string): Promise<SnapshotFile> {
  const path = absoluteFromRelative(root, relativePath);
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`Legacy state must contain only safe regular files: ${relativePath}`);
  }
  if (before.size > MAX_BACKUP_FILE_BYTES) throw new Error(`Legacy state file is too large: ${relativePath}`);
  const contents = await readFile(path);
  const after = await lstat(path);
  if (
    after.isSymbolicLink() ||
    !after.isFile() ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    contents.byteLength !== after.size
  ) {
    throw new Error(`Legacy state changed while it was being backed up: ${relativePath}`);
  }
  return {
    path: relativePath,
    bytes: contents.byteLength,
    sha256: sha256(contents),
    mode: snapshotMode(before.mode),
    contents,
  };
}

async function collectDirectoryFiles(root: string, relativeDirectory: string): Promise<SnapshotFile[]> {
  const directory = absoluteFromRelative(root, relativeDirectory);
  const details = await lstat(directory);
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new Error(`Legacy state directory is unsafe: ${relativeDirectory}`);
  }
  const files: SnapshotFile[] = [];
  const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name)
  );
  for (const entry of entries) {
    const relativePath = posix.join(relativeDirectory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Legacy state contains a symbolic link: ${relativePath}`);
    if (entry.isDirectory()) files.push(...(await collectDirectoryFiles(root, relativePath)));
    else if (entry.isFile()) files.push(await readStableFile(root, relativePath));
    else throw new Error(`Legacy state contains an unsupported entry: ${relativePath}`);
  }
  return files;
}

function isLegacyRootFile(entry: Dirent): boolean {
  return LEGACY_ROOT_FILE_NAMES.has(entry.name) || entry.name.endsWith('.note.md');
}

function isRemovableLegacyRootFile(entry: Dirent): boolean {
  return entry.name !== STATE_LAYOUT_FILE && isLegacyRootFile(entry);
}

async function collectLegacySnapshot(stateDirectory: string): Promise<SnapshotFile[]> {
  const files: SnapshotFile[] = [];
  const entries = (await readdir(stateDirectory, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name)
  );
  for (const entry of entries) {
    if (LEGACY_DIRECTORY_NAMES.has(entry.name)) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new Error(`Legacy state directory is unsafe: ${entry.name}`);
      }
      files.push(...(await collectDirectoryFiles(stateDirectory, entry.name)));
      continue;
    }
    if (!isLegacyRootFile(entry)) continue;
    if (entry.isSymbolicLink() || !entry.isFile()) throw new Error(`Legacy state file is unsafe: ${entry.name}`);
    files.push(await readStableFile(stateDirectory, entry.name));
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  const totalBytes = files.reduce((total, file) => total + file.bytes, 0);
  if (totalBytes > MAX_BACKUP_TOTAL_BYTES) throw new Error('Legacy Vampire state is too large to migrate safely.');
  return files;
}

function manifestFor(files: readonly SnapshotFile[], createdAt: string): BackupManifest {
  return {
    version: BACKUP_FORMAT_VERSION,
    migration: ORGANIZED_STATE_MIGRATION_NAME,
    createdAt,
    files: files.map(({ path, bytes, sha256: digest, mode }) => ({ path, bytes, sha256: digest, mode })),
  };
}

function parseBackupManifest(value: unknown): BackupManifest {
  if (
    !isRecord(value) ||
    value.version !== BACKUP_FORMAT_VERSION ||
    value.migration !== ORGANIZED_STATE_MIGRATION_NAME ||
    typeof value.createdAt !== 'string' ||
    !Array.isArray(value.files)
  ) {
    throw new Error('The organized-state backup manifest is invalid.');
  }
  const timestamp = Date.parse(value.createdAt);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value.createdAt) {
    throw new Error('The organized-state backup timestamp is invalid.');
  }
  const files: BackupManifest['files'] = [];
  const seen = new Set<string>();
  let previous = '';
  let totalBytes = 0;
  for (const file of value.files) {
    if (
      !isRecord(file) ||
      typeof file.path !== 'string' ||
      !isLegacySnapshotPath(file.path) ||
      file.path <= previous ||
      seen.has(file.path) ||
      !Number.isSafeInteger(file.bytes) ||
      (file.bytes as number) < 0 ||
      (file.bytes as number) > MAX_BACKUP_FILE_BYTES ||
      typeof file.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      (file.mode !== 0o600 && file.mode !== 0o700)
    ) {
      throw new Error('The organized-state backup manifest contains an invalid file.');
    }
    totalBytes += file.bytes as number;
    if (totalBytes > MAX_BACKUP_TOTAL_BYTES) throw new Error('The organized-state backup is too large.');
    previous = file.path;
    seen.add(file.path);
    files.push({
      path: file.path,
      bytes: file.bytes as number,
      sha256: file.sha256,
      mode: file.mode,
    });
  }
  return {
    version: BACKUP_FORMAT_VERSION,
    migration: ORGANIZED_STATE_MIGRATION_NAME,
    createdAt: value.createdAt,
    files,
  };
}

async function readBackup(backupDirectory: string): Promise<Map<string, SnapshotFile>> {
  await assertExistingSafeDirectoryChain(backupDirectory);
  const manifestPath = join(backupDirectory, ORGANIZED_STATE_BACKUP_MANIFEST);
  const manifestDetails = await lstat(manifestPath);
  if (manifestDetails.isSymbolicLink() || !manifestDetails.isFile() || manifestDetails.size > 1024 * 1024) {
    throw new Error('The organized-state backup manifest is not a safe regular file.');
  }
  const manifest = parseBackupManifest(JSON.parse(await readFile(manifestPath, 'utf8')) as unknown);
  const files = new Map<string, SnapshotFile>();
  for (const entry of manifest.files) {
    await assertExistingSafeDirectoryChain(
      backupDirectory,
      posix.dirname(`legacy/${entry.path}`) === '.' ? '' : posix.dirname(`legacy/${entry.path}`)
    );
    const path = join(backupDirectory, 'legacy', ...entry.path.split('/'));
    const fileDetails = await lstat(path);
    if (fileDetails.isSymbolicLink() || !fileDetails.isFile() || fileDetails.size !== entry.bytes) {
      throw new Error(`The organized-state backup file is invalid: ${entry.path}`);
    }
    const contents = await readFile(path);
    if (sha256(contents) !== entry.sha256) {
      throw new Error(`The organized-state backup checksum does not match: ${entry.path}`);
    }
    files.set(entry.path, { ...entry, contents });
  }
  return files;
}

function sameSnapshot(left: readonly SnapshotFile[], right: readonly SnapshotFile[]): boolean {
  const comparable = (files: readonly SnapshotFile[]) =>
    files.map(({ path, bytes, sha256: digest, mode }) => ({ path, bytes, sha256: digest, mode }));
  return JSON.stringify(comparable(left)) === JSON.stringify(comparable(right));
}

async function createOrReadBackup(stateDirectory: string): Promise<Map<string, SnapshotFile>> {
  const backupDirectory = absoluteFromRelative(stateDirectory, ORGANIZED_STATE_BACKUP_DIRECTORY);
  try {
    const details = await lstat(backupDirectory);
    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw new Error('The organized-state backup path is not a safe directory.');
    }
  } catch (error) {
    if (errorHasFileCode(error, 'ENOENT')) {
      // The first attempt creates a fresh, immutable backup below.
    } else {
      throw error;
    }
    const snapshot = await collectLegacySnapshot(stateDirectory);
    const backupsDirectory = dirname(backupDirectory);
    await ensurePrivateDirectory(backupsDirectory);
    const stagingDirectory = join(backupsDirectory, `.${basename(backupDirectory)}.${randomUUID()}.staging`);
    await mkdir(stagingDirectory, { mode: 0o700 });
    try {
      for (const file of snapshot) {
        const destination = join(stagingDirectory, 'legacy', ...file.path.split('/'));
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        await writeFile(destination, file.contents, { flag: 'wx', mode: file.mode });
      }
      await writeFile(
        join(stagingDirectory, ORGANIZED_STATE_BACKUP_MANIFEST),
        json(manifestFor(snapshot, new Date().toISOString())),
        { encoding: 'utf8', flag: 'wx', mode: 0o600 }
      );
      await readBackup(stagingDirectory);
      const verifiedSource = await collectLegacySnapshot(stateDirectory);
      if (!sameSnapshot(snapshot, verifiedSource)) throw new Error('Legacy Vampire state changed during backup.');
      await rename(stagingDirectory, backupDirectory);
      await syncDirectory(backupsDirectory);
    } catch (error_) {
      await rm(stagingDirectory, { recursive: true, force: true });
      throw error_;
    }
    return readBackup(backupDirectory);
  }
  return readBackup(backupDirectory);
}

function parseJsonFile(file: SnapshotFile | undefined, label: string): unknown | undefined {
  if (!file) return undefined;
  try {
    return JSON.parse(file.contents.toString('utf8')) as unknown;
  } catch (error) {
    throw new Error(`${label} contains invalid JSON.`, { cause: error });
  }
}

function rawWorkspaceById(rawState: unknown): Map<string, Record<string, unknown>> {
  if (!isRecord(rawState)) return new Map();
  const rawWorkspaces = Array.isArray(rawState.workspaces)
    ? rawState.workspaces
    : Array.isArray(rawState.sessions)
      ? rawState.sessions
      : [];
  return new Map(
    rawWorkspaces
      .filter(
        (workspace): workspace is Record<string, unknown> => isRecord(workspace) && typeof workspace.id === 'string'
      )
      .map((workspace) => [workspace.id as string, workspace])
  );
}

function workspaceStateFromBackup(files: Map<string, SnapshotFile>): {
  state: WorkspaceStore;
  rawById: Map<string, Record<string, unknown>>;
  revision: string;
} {
  const sessions = files.get(VAMPIRE_LEGACY_STATE_FILE);
  const rawState = parseJsonFile(sessions, VAMPIRE_LEGACY_STATE_FILE) ?? { version: 1, workspaces: [] };
  const state = parseWorkspaceStore(rawState);
  const fingerprint = [...files.values()]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((file) => `${file.path}\0${file.sha256}`)
    .join('\0');
  return {
    state,
    rawById: rawWorkspaceById(rawState),
    revision: `migration-${sha256(fingerprint || 'empty-state').slice(0, 32)}`,
  };
}

function composerSettingsDocument(files: Map<string, SnapshotFile>): string {
  const value = parseJsonFile(files.get('composer-history/settings.json'), 'composer-history/settings.json');
  if (value !== undefined) {
    if (!isRecord(value) || value.version !== 1 || !isWorkspaceComposerHistorySettings(value)) {
      throw new Error('The legacy Composer history settings are invalid.');
    }
    return json({ version: 1, enabled: value.enabled, limit: value.limit });
  }
  return json({ version: 1, ...DEFAULT_WORKSPACE_COMPOSER_HISTORY_SETTINGS });
}

function terminalInputDocument(files: Map<string, SnapshotFile>): string {
  const value = parseJsonFile(files.get('terminal-input-settings.json'), 'terminal-input-settings.json');
  if (value !== undefined && !isTerminalInputSettings(value)) {
    throw new Error('The legacy terminal input settings are invalid.');
  }
  const settings = value === undefined ? DEFAULT_TERMINAL_INPUT_SETTINGS : value;
  return json({ version: 2, mode: settings.mode, slashHandoff: settings.slashHandoff });
}

function statusWidgetsDocument(files: Map<string, SnapshotFile>): string {
  const existing = files.get('status-plugins.json');
  if (!existing) return json({ version: 1, plugins: defaultStatusPlugins() });
  const value = parseJsonFile(existing, 'status-plugins.json');
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.plugins)) {
    throw new Error('The legacy status widget settings are invalid.');
  }
  const plugins = value.plugins.map((plugin): unknown => {
    if (!isRecord(plugin) || !isRecord(plugin.source) || plugin.source.type !== 'system') return plugin;
    const command =
      plugin.source.metric === 'cpu'
        ? STATUS_PLUGIN_CPU_COMMAND
        : plugin.source.metric === 'memory'
          ? STATUS_PLUGIN_MEMORY_COMMAND
          : undefined;
    return command ? { ...plugin, source: { type: 'command', command } } : plugin;
  });
  if (!isStatusPluginList(plugins)) throw new Error('The legacy status widget settings are invalid.');
  return json({ version: 1, plugins });
}

function legacyWorkspaceFile(
  files: Map<string, SnapshotFile>,
  workspaceId: string,
  suffix: string
): SnapshotFile | undefined {
  return files.get(`${vampireWorkspaceStateKey(workspaceId)}${suffix}`);
}

function workspaceNoteContents(
  files: Map<string, SnapshotFile>,
  workspaceId: string,
  rawWorkspace: Record<string, unknown> | undefined
): Buffer {
  const existing = legacyWorkspaceFile(files, workspaceId, '.note.md');
  if (existing && existing.bytes > MAX_NOTE_BYTES + 1) throw new Error(`Workspace note is too large: ${workspaceId}`);
  const legacyNote = typeof rawWorkspace?.note === 'string' ? rawWorkspace.note.trim() : '';
  if (Buffer.byteLength(legacyNote) > MAX_NOTE_BYTES) throw new Error(`Workspace note is too large: ${workspaceId}`);
  if (existing && existing.contents.toString('utf8').trim()) return existing.contents;
  return Buffer.from(legacyNote ? `${legacyNote}\n` : '');
}

function parseHistory(value: unknown, label: string): WorkspaceComposerPrompt[] {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.prompts)) {
    throw new Error(`${label} is invalid.`);
  }
  return normalizeWorkspaceComposerPromptHistory(value.prompts, MAX_WORKSPACE_COMPOSER_PROMPTS);
}

function mergedHistory(
  files: Map<string, SnapshotFile>,
  workspaceId: string,
  rawWorkspace: Record<string, unknown> | undefined
): string {
  const historyPath = `composer-history/workspaces/${vampireWorkspaceStateKey(workspaceId)}.json`;
  const fileHistory = files.has(historyPath)
    ? parseHistory(parseJsonFile(files.get(historyPath), historyPath), historyPath)
    : [];
  const inline = normalizeWorkspaceComposerPromptHistory(
    rawWorkspace?.composerPromptHistory,
    MAX_WORKSPACE_COMPOSER_PROMPTS
  );
  const byId = new Map<string, WorkspaceComposerPrompt>();
  for (const prompt of [...inline, ...fileHistory]) byId.set(prompt.id, prompt);
  const prompts = [...byId.values()]
    .sort((left, right) => left.submittedAt - right.submittedAt)
    .slice(-MAX_WORKSPACE_COMPOSER_PROMPTS);
  return json({ version: 1, prompts });
}

function orphanedWorkspaceArtifactKey(
  path: string,
  prefix: string,
  suffix: string,
  activeWorkspaceKeys: Set<string>
): string | undefined {
  if (!path.startsWith(prefix) || !path.endsWith(suffix)) return undefined;
  const legacyKey = path.slice(prefix.length, -suffix.length);
  if (!legacyKey || legacyKey.includes('/')) return undefined;
  const workspaceKey = vampireWorkspaceStateKey(legacyKey);
  return activeWorkspaceKeys.has(workspaceKey) ? undefined : workspaceKey;
}

async function materializeOrphanedWorkspaceArtifacts(
  stageDirectory: string,
  files: Map<string, SnapshotFile>,
  state: WorkspaceStore
): Promise<void> {
  const activeWorkspaceKeys = new Set(state.workspaces.map((workspace) => vampireWorkspaceStateKey(workspace.id)));
  for (const file of files.values()) {
    const noteKey = orphanedWorkspaceArtifactKey(file.path, '', '.note.md', activeWorkspaceKeys);
    if (noteKey) {
      if (file.bytes > MAX_NOTE_BYTES + 1) throw new Error(`Orphaned workspace note is too large: ${file.path}`);
      await writeTargetFile(
        stageDirectory,
        `${VAMPIRE_WORKSPACES_DIRECTORY}/${noteKey}/${VAMPIRE_WORKSPACE_NOTE_FILE}`,
        file.contents,
        file.mode
      );
      continue;
    }

    const historyKey = orphanedWorkspaceArtifactKey(
      file.path,
      'composer-history/workspaces/',
      '.json',
      activeWorkspaceKeys
    );
    if (!historyKey) continue;
    const prompts = parseHistory(parseJsonFile(file, file.path), file.path);
    await writeTargetFile(
      stageDirectory,
      `${VAMPIRE_WORKSPACES_DIRECTORY}/${historyKey}/${VAMPIRE_WORKSPACE_COMPOSER_HISTORY_FILE}`,
      json({ version: 1, prompts }),
      file.mode
    );
  }
}

async function ensureSafeDirectoryChain(root: string, relativeDirectory: string): Promise<void> {
  await ensurePrivateDirectory(root);
  let current = root;
  for (const part of relativeDirectory.split('/').filter(Boolean)) {
    current = join(current, part);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (!errorHasFileCode(error, 'EEXIST')) throw error;
    }
    const details = await lstat(current);
    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw new Error(`Migration target is not a safe directory: ${current}`);
    }
  }
}

async function writeTargetFile(
  root: string,
  relativePath: string,
  contents: string | Buffer,
  mode = 0o600
): Promise<void> {
  await ensureSafeDirectoryChain(root, posix.dirname(relativePath) === '.' ? '' : posix.dirname(relativePath));
  const path = absoluteFromRelative(root, relativePath);
  try {
    const details = await lstat(path);
    if (details.isSymbolicLink() || !details.isFile()) throw new Error(`Migration target is unsafe: ${relativePath}`);
    const current = await readFile(path);
    const requested = typeof contents === 'string' ? Buffer.from(contents) : contents;
    if (!current.equals(requested))
      throw new Error(`Migration target already contains different data: ${relativePath}`);
    return;
  } catch (error) {
    if (!errorHasFileCode(error, 'ENOENT')) throw error;
  }
  await atomicWriteFile(path, contents, mode);
}

async function copySupportFiles(files: Map<string, SnapshotFile>, stageDirectory: string): Promise<void> {
  const mappings = [
    { source: 'agent-guides/', target: `${VAMPIRE_AGENT_SUPPORT_DIRECTORY}/${VAMPIRE_AGENT_GUIDES_DIRECTORY}/` },
    {
      source: 'automation-requests/',
      target: `${VAMPIRE_AGENT_SUPPORT_DIRECTORY}/${VAMPIRE_AGENT_REQUESTS_DIRECTORY}/automations/`,
    },
  ];
  for (const mapping of mappings) {
    for (const file of files.values()) {
      if (!file.path.startsWith(mapping.source)) continue;
      await writeTargetFile(
        stageDirectory,
        `${mapping.target}${file.path.slice(mapping.source.length)}`,
        file.contents,
        file.mode
      );
    }
  }
  await ensureSafeDirectoryChain(
    stageDirectory,
    `${VAMPIRE_AGENT_SUPPORT_DIRECTORY}/${VAMPIRE_AGENT_GUIDES_DIRECTORY}`
  );
  await ensureSafeDirectoryChain(
    stageDirectory,
    `${VAMPIRE_AGENT_SUPPORT_DIRECTORY}/${VAMPIRE_AGENT_REQUESTS_DIRECTORY}/automations`
  );
}

async function materializeStagingState(
  stageDirectory: string,
  files: Map<string, SnapshotFile>,
  state: WorkspaceStore,
  rawById: Map<string, Record<string, unknown>>,
  revision: string
): Promise<void> {
  await writeStructuredWorkspaceState(state, { stateDirectory: stageDirectory, revision });
  await writeTargetFile(
    stageDirectory,
    `${VAMPIRE_GLOBAL_DIRECTORY}/${VAMPIRE_GLOBAL_STATUS_WIDGETS_FILE}`,
    statusWidgetsDocument(files)
  );
  await writeTargetFile(
    stageDirectory,
    `${VAMPIRE_GLOBAL_DIRECTORY}/${VAMPIRE_GLOBAL_TERMINAL_INPUT_FILE}`,
    terminalInputDocument(files)
  );
  await writeTargetFile(
    stageDirectory,
    `${VAMPIRE_GLOBAL_DIRECTORY}/${VAMPIRE_GLOBAL_COMPOSER_HISTORY_FILE}`,
    composerSettingsDocument(files)
  );
  for (const workspace of state.workspaces) {
    const prefix = `${VAMPIRE_WORKSPACES_DIRECTORY}/${vampireWorkspaceStateKey(workspace.id)}`;
    await writeTargetFile(
      stageDirectory,
      `${prefix}/${VAMPIRE_WORKSPACE_NOTE_FILE}`,
      workspaceNoteContents(files, workspace.id, rawById.get(workspace.id))
    );
    await writeTargetFile(
      stageDirectory,
      `${prefix}/${VAMPIRE_WORKSPACE_COMPOSER_HISTORY_FILE}`,
      mergedHistory(files, workspace.id, rawById.get(workspace.id))
    );
  }
  await materializeOrphanedWorkspaceArtifacts(stageDirectory, files, state);
  await copySupportFiles(files, stageDirectory);
}

async function readRequiredJson(path: string, label: string): Promise<unknown> {
  const details = await lstat(path);
  if (details.isSymbolicLink() || !details.isFile() || details.size > MAX_BACKUP_FILE_BYTES) {
    throw new Error(`${label} must be a safe regular file.`);
  }
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`${label} contains invalid JSON.`, { cause: error });
  }
}

async function assertSafeDirectory(path: string, label: string): Promise<void> {
  const details = await lstat(path);
  if (details.isSymbolicLink() || !details.isDirectory()) throw new Error(`${label} must be a safe directory.`);
}

async function legacyEntryExists(stateDirectory: string): Promise<boolean> {
  for (const entry of await readdir(stateDirectory, { withFileTypes: true })) {
    if (LEGACY_DIRECTORY_NAMES.has(entry.name) || isRemovableLegacyRootFile(entry)) return true;
  }
  return false;
}

async function validateOrganizedState(stateDirectory: string, allowLegacy: boolean): Promise<WorkspaceStore> {
  const state = await readStructuredWorkspaceState(stateDirectory);
  const status = await readRequiredJson(
    join(stateDirectory, VAMPIRE_GLOBAL_DIRECTORY, VAMPIRE_GLOBAL_STATUS_WIDGETS_FILE),
    `global/${VAMPIRE_GLOBAL_STATUS_WIDGETS_FILE}`
  );
  if (!isRecord(status) || status.version !== 1 || !isStatusPluginList(status.plugins)) {
    throw new Error('The organized status widget document is invalid.');
  }
  const terminal = await readRequiredJson(
    join(stateDirectory, VAMPIRE_GLOBAL_DIRECTORY, VAMPIRE_GLOBAL_TERMINAL_INPUT_FILE),
    `global/${VAMPIRE_GLOBAL_TERMINAL_INPUT_FILE}`
  );
  if (!isRecord(terminal) || terminal.version !== 2 || !isTerminalInputSettings(terminal)) {
    throw new Error('The organized terminal input document is invalid.');
  }
  const composer = await readRequiredJson(
    join(stateDirectory, VAMPIRE_GLOBAL_DIRECTORY, VAMPIRE_GLOBAL_COMPOSER_HISTORY_FILE),
    `global/${VAMPIRE_GLOBAL_COMPOSER_HISTORY_FILE}`
  );
  if (!isRecord(composer) || composer.version !== 1 || !isWorkspaceComposerHistorySettings(composer)) {
    throw new Error('The organized Composer history settings are invalid.');
  }
  for (const workspace of state.workspaces) {
    const directory = join(stateDirectory, VAMPIRE_WORKSPACES_DIRECTORY, vampireWorkspaceStateKey(workspace.id));
    await assertSafeDirectory(directory, `${workspace.id} workspace directory`);
    const notePath = join(directory, VAMPIRE_WORKSPACE_NOTE_FILE);
    const note = await lstat(notePath);
    if (note.isSymbolicLink() || !note.isFile() || note.size > MAX_NOTE_BYTES + 1) {
      throw new Error(`The organized workspace note is invalid: ${workspace.id}`);
    }
    const history = await readRequiredJson(
      join(directory, VAMPIRE_WORKSPACE_COMPOSER_HISTORY_FILE),
      `${workspace.id}/${VAMPIRE_WORKSPACE_COMPOSER_HISTORY_FILE}`
    );
    if (
      !isRecord(history) ||
      history.version !== 1 ||
      !Array.isArray(history.prompts) ||
      history.prompts.length > MAX_WORKSPACE_COMPOSER_PROMPTS ||
      !history.prompts.every(isWorkspaceComposerPrompt)
    ) {
      throw new Error(`The organized Composer history is invalid: ${workspace.id}`);
    }
  }
  await assertSafeDirectory(
    join(stateDirectory, VAMPIRE_AGENT_SUPPORT_DIRECTORY, VAMPIRE_AGENT_GUIDES_DIRECTORY),
    'agent-support/guides'
  );
  await assertSafeDirectory(
    join(stateDirectory, VAMPIRE_AGENT_SUPPORT_DIRECTORY, VAMPIRE_AGENT_REQUESTS_DIRECTORY, 'automations'),
    'agent-support/requests/automations'
  );
  if (!allowLegacy && (await legacyEntryExists(stateDirectory))) {
    throw new Error('Legacy state remains outside the organized state directories.');
  }
  return state;
}

async function collectFilesRecursively(root: string, relativeDirectory = ''): Promise<string[]> {
  const directory = relativeDirectory ? absoluteFromRelative(root, relativeDirectory) : root;
  const files: string[] = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name)
  )) {
    const relativePath = relativeDirectory ? posix.join(relativeDirectory, entry.name) : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Migration staging contains a symbolic link: ${relativePath}`);
    if (entry.isDirectory()) files.push(...(await collectFilesRecursively(root, relativePath)));
    else if (entry.isFile()) files.push(relativePath);
    else throw new Error(`Migration staging contains an unsupported entry: ${relativePath}`);
  }
  return files;
}

function isStructuredAggregatePath(path: string): boolean {
  if (path === VAMPIRE_REGISTRY_FILE) return true;
  if (path === `${VAMPIRE_GLOBAL_DIRECTORY}/settings.json`) return true;
  if (path === `${VAMPIRE_GLOBAL_DIRECTORY}/launch-profiles.json`) return true;
  const parts = path.split('/');
  return (
    parts.length === 3 &&
    parts[0] === VAMPIRE_WORKSPACES_DIRECTORY &&
    (parts[2] === 'settings.json' || parts[2] === 'automations.json' || parts[2] === 'background.json')
  );
}

async function installStagedAncillaryFiles(stageDirectory: string, stateDirectory: string): Promise<void> {
  for (const relativePath of await collectFilesRecursively(stageDirectory)) {
    if (isStructuredAggregatePath(relativePath)) continue;
    const source = absoluteFromRelative(stageDirectory, relativePath);
    const details = await lstat(source);
    await writeTargetFile(stateDirectory, relativePath, await readFile(source), snapshotMode(details.mode));
  }
  await ensureSafeDirectoryChain(
    stateDirectory,
    `${VAMPIRE_AGENT_SUPPORT_DIRECTORY}/${VAMPIRE_AGENT_GUIDES_DIRECTORY}`
  );
  await ensureSafeDirectoryChain(
    stateDirectory,
    `${VAMPIRE_AGENT_SUPPORT_DIRECTORY}/${VAMPIRE_AGENT_REQUESTS_DIRECTORY}/automations`
  );
}

async function assertStructuredCommitCanProceed(stateDirectory: string, state: WorkspaceStore): Promise<void> {
  if (await structuredWorkspaceStateExists(stateDirectory)) {
    const current = await readStructuredWorkspaceState(stateDirectory);
    if (!isDeepStrictEqual(current, state)) {
      throw new Error('An existing organized workspace registry conflicts with the migration source.');
    }
    return;
  }
  const paths = [
    join(stateDirectory, VAMPIRE_GLOBAL_DIRECTORY, VAMPIRE_GLOBAL_SETTINGS_FILE),
    join(stateDirectory, VAMPIRE_GLOBAL_DIRECTORY, VAMPIRE_GLOBAL_LAUNCH_PROFILES_FILE),
    ...state.workspaces.flatMap((workspace) => {
      const directory = join(stateDirectory, VAMPIRE_WORKSPACES_DIRECTORY, vampireWorkspaceStateKey(workspace.id));
      return [
        join(directory, VAMPIRE_WORKSPACE_SETTINGS_FILE),
        join(directory, VAMPIRE_WORKSPACE_AUTOMATIONS_FILE),
        join(directory, VAMPIRE_WORKSPACE_BACKGROUND_FILE),
      ];
    }),
  ];
  for (const path of paths) {
    try {
      await lstat(path);
      throw new Error(`An uncommitted organized state file blocks migration: ${path}`);
    } catch (error) {
      if (!errorHasFileCode(error, 'ENOENT')) throw error;
    }
  }
}

async function removeLegacyState(stateDirectory: string, backup: Map<string, SnapshotFile>): Promise<void> {
  const removableRootFiles = new Set(
    [...backup.keys()].filter((path) => !path.includes('/') && path !== STATE_LAYOUT_FILE).map((path) => path)
  );
  for (const file of removableRootFiles) {
    const path = join(stateDirectory, file);
    try {
      const details = await lstat(path);
      if (details.isSymbolicLink() || !details.isFile()) throw new Error(`Legacy cleanup target is unsafe: ${file}`);
      const expected = backup.get(file)!;
      const contents = await readFile(path);
      if (sha256(contents) !== expected.sha256) {
        throw new Error(`Legacy state changed after backup; refusing to remove it: ${file}`);
      }
      await unlink(path);
    } catch (error) {
      if (!errorHasFileCode(error, 'ENOENT')) throw error;
    }
  }
  for (const directoryName of LEGACY_DIRECTORY_NAMES) {
    const path = join(stateDirectory, directoryName);
    try {
      const details = await lstat(path);
      if (details.isSymbolicLink() || !details.isDirectory()) {
        throw new Error(`Legacy cleanup target is unsafe: ${directoryName}`);
      }
      const current = (await collectDirectoryFiles(stateDirectory, directoryName)).sort((left, right) =>
        left.path.localeCompare(right.path)
      );
      const expected = [...backup.values()]
        .filter((file) => file.path.startsWith(`${directoryName}/`))
        .sort((left, right) => left.path.localeCompare(right.path));
      if (!sameSnapshot(current, expected)) {
        throw new Error(`Legacy state changed after backup; refusing to remove it: ${directoryName}`);
      }
      await rm(path, { recursive: true });
    } catch (error) {
      if (!errorHasFileCode(error, 'ENOENT')) throw error;
    }
  }
  await syncDirectory(stateDirectory);
}

export async function validateOrganizedStateDirectory(stateDirectory: string): Promise<void> {
  await validateOrganizedState(stateDirectory, false);
}

export async function organizeStateDirectory(context: StateMigrationContext): Promise<void> {
  const { stateDirectory } = context;
  const backup = await createOrReadBackup(stateDirectory);
  const { state, rawById, revision } = workspaceStateFromBackup(backup);
  const stageDirectory = join(stateDirectory, ORGANIZED_STATE_STAGING_DIRECTORY);
  try {
    const stageDetails = await lstat(stageDirectory).catch((error) => {
      if (errorHasFileCode(error, 'ENOENT')) return undefined;
      throw error;
    });
    if (stageDetails?.isSymbolicLink() || (stageDetails && !stageDetails.isDirectory())) {
      throw new Error('The organized-state staging path is unsafe.');
    }
    if (stageDetails) await rm(stageDirectory, { recursive: true });
    await mkdir(stageDirectory, { mode: 0o700 });
    await materializeStagingState(stageDirectory, backup, state, rawById, revision);
    await validateOrganizedState(stageDirectory, true);
    await assertStructuredCommitCanProceed(stateDirectory, state);
    await installStagedAncillaryFiles(stageDirectory, stateDirectory);
    await writeStructuredWorkspaceState(state, { stateDirectory, revision });
    await validateOrganizedState(stateDirectory, true);
    await removeLegacyState(stateDirectory, backup);
    await validateOrganizedState(stateDirectory, false);
  } finally {
    await rm(stageDirectory, { recursive: true, force: true });
  }
}

export const organizeStateDirectoryMigration = {
  name: ORGANIZED_STATE_MIGRATION_NAME,
  layoutVersion: 1,
  checksumInput: 'vampire-state-migration:0001-organize-state-directory:ownership-layout:v1',
  up: organizeStateDirectory,
  validate: ({ stateDirectory }: StateMigrationContext) => validateOrganizedStateDirectory(stateDirectory),
} satisfies StateMigrationSource;
