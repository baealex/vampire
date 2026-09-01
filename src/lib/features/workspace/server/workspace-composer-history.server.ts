import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { errorHasCode } from '~/lib/server/path-policy.ts';
import { vampireStateDirectory } from '~/lib/server/state-path.ts';
import {
  DEFAULT_WORKSPACE_COMPOSER_HISTORY_SETTINGS,
  isWorkspaceComposerHistorySettings,
  MAX_WORKSPACE_COMPOSER_PROMPTS,
  normalizeWorkspaceComposerPromptHistory,
  WORKSPACE_COMPOSER_PROMPT_MAX_LENGTH,
  workspaceComposerPromptPreview,
  type WorkspaceComposerHistorySettings,
  type WorkspaceComposerPrompt,
  type WorkspaceComposerPromptPreview,
} from '~/lib/shared/contracts/workspace-composer-history.ts';
import {
  readWorkspaceStateFile,
  readWorkspaceStore,
  withWorkspaceStoreMutation,
  writeWorkspaceStore,
} from './workspace-store.server.ts';

const COMPOSER_HISTORY_VERSION = 1;
const COMPOSER_HISTORY_DIRECTORY = 'composer-history';
const COMPOSER_HISTORY_WORKSPACES_DIRECTORY = 'workspaces';
const COMPOSER_HISTORY_SETTINGS_FILE = 'settings.json';
const SAFE_WORKSPACE_HISTORY_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MAX_COMPOSER_HISTORY_FILE_BYTES =
  MAX_WORKSPACE_COMPOSER_PROMPTS * WORKSPACE_COMPOSER_PROMPT_MAX_LENGTH * 4 + 64 * 1_024;
const MAX_COMPOSER_HISTORY_SETTINGS_BYTES = 64 * 1_024;

type ComposerHistoryDocument = {
  version: typeof COMPOSER_HISTORY_VERSION;
  prompts: WorkspaceComposerPrompt[];
};

type ComposerHistorySettingsDocument = WorkspaceComposerHistorySettings & {
  version: typeof COMPOSER_HISTORY_VERSION;
};

export type WorkspaceComposerHistoryErrorReason = 'not-found' | 'invalid-prompt' | 'invalid-settings';

export class WorkspaceComposerHistoryError extends Error {
  readonly reason: WorkspaceComposerHistoryErrorReason;

  constructor(reason: WorkspaceComposerHistoryErrorReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function managedWorkspaceComposerHistoryFileName(workspaceId: string): string {
  const safeId = SAFE_WORKSPACE_HISTORY_ID.test(workspaceId)
    ? workspaceId
    : createHash('sha256').update(workspaceId).digest('hex');
  return `${safeId}.json`;
}

export function managedWorkspaceComposerHistoryDirectory(): string {
  return join(vampireStateDirectory(), COMPOSER_HISTORY_DIRECTORY);
}

export function managedWorkspaceComposerHistorySettingsPath(): string {
  return join(managedWorkspaceComposerHistoryDirectory(), COMPOSER_HISTORY_SETTINGS_FILE);
}

export function managedWorkspaceComposerHistoryPath(workspaceId: string): string {
  return join(
    managedWorkspaceComposerHistoryDirectory(),
    COMPOSER_HISTORY_WORKSPACES_DIRECTORY,
    managedWorkspaceComposerHistoryFileName(workspaceId)
  );
}

async function ensureParentDirectory(path: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const details = await stat(directory);
  if (!details.isDirectory()) throw new Error('The Composer history path is not a directory.');
}

async function assertRegularFile(path: string, maximumBytes: number): Promise<'missing' | 'regular'> {
  try {
    const details = await lstat(path);
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new Error('The managed Composer history path is not a regular file.');
    }
    if (details.size > maximumBytes) throw new Error('The managed Composer history file is too large to read safely.');
    return 'regular';
  } catch (error) {
    if (errorHasCode(error, 'ENOENT')) return 'missing';
    throw error;
  }
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await ensureParentDirectory(path);
  const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temporaryPath, path);
  } catch (error) {
    try {
      await unlink(temporaryPath);
    } catch {
      // The temporary file may not have been created.
    }
    throw error;
  }
}

function normalizeComposerPrompt(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > WORKSPACE_COMPOSER_PROMPT_MAX_LENGTH ||
    value.includes('\0')
  ) {
    throw new WorkspaceComposerHistoryError(
      'invalid-prompt',
      `Composer prompts must be between 1 and ${WORKSPACE_COMPOSER_PROMPT_MAX_LENGTH.toLocaleString('en-US')} characters.`
    );
  }
  return value;
}

function parseHistoryDocument(value: unknown, limit: number): WorkspaceComposerPrompt[] {
  if (!isRecord(value) || value.version !== COMPOSER_HISTORY_VERSION || !Array.isArray(value.prompts)) {
    throw new Error('The managed Composer history file is invalid.');
  }
  return normalizeWorkspaceComposerPromptHistory(value.prompts, limit);
}

async function readHistoryFile(workspaceId: string, limit: number): Promise<WorkspaceComposerPrompt[] | undefined> {
  const path = managedWorkspaceComposerHistoryPath(workspaceId);
  if ((await assertRegularFile(path, MAX_COMPOSER_HISTORY_FILE_BYTES)) === 'missing') return undefined;
  return parseHistoryDocument(JSON.parse(await readFile(path, 'utf8')) as unknown, limit);
}

async function writeHistoryFile(workspaceId: string, prompts: WorkspaceComposerPrompt[]): Promise<void> {
  const document: ComposerHistoryDocument = {
    version: COMPOSER_HISTORY_VERSION,
    prompts: normalizeWorkspaceComposerPromptHistory(prompts, MAX_WORKSPACE_COMPOSER_PROMPTS),
  };
  await writeJsonFile(managedWorkspaceComposerHistoryPath(workspaceId), document);
}

export async function readManagedWorkspaceComposerHistorySettings(): Promise<WorkspaceComposerHistorySettings> {
  const path = managedWorkspaceComposerHistorySettingsPath();
  if ((await assertRegularFile(path, MAX_COMPOSER_HISTORY_SETTINGS_BYTES)) === 'missing') {
    return { ...DEFAULT_WORKSPACE_COMPOSER_HISTORY_SETTINGS };
  }
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!isRecord(value) || value.version !== COMPOSER_HISTORY_VERSION || !isWorkspaceComposerHistorySettings(value)) {
    throw new Error('The Composer history settings file is invalid.');
  }
  return { enabled: value.enabled, limit: value.limit };
}

async function writeManagedWorkspaceComposerHistorySettings(settings: WorkspaceComposerHistorySettings): Promise<void> {
  const document: ComposerHistorySettingsDocument = { version: COMPOSER_HISTORY_VERSION, ...settings };
  await writeJsonFile(managedWorkspaceComposerHistorySettingsPath(), document);
}

export async function updateManagedWorkspaceComposerHistorySettings(
  value: unknown
): Promise<WorkspaceComposerHistorySettings> {
  if (!isWorkspaceComposerHistorySettings(value)) {
    throw new WorkspaceComposerHistoryError(
      'invalid-settings',
      `Composer history must keep between 1 and ${MAX_WORKSPACE_COMPOSER_PROMPTS} prompts per workspace.`
    );
  }
  const settings = { enabled: value.enabled, limit: value.limit };
  return withWorkspaceStoreMutation(async () => {
    const state = await readWorkspaceStore();
    await writeManagedWorkspaceComposerHistorySettings(settings);
    await Promise.all(
      state.workspaces.map(async (workspace) => {
        const prompts = await readHistoryFile(workspace.id, MAX_WORKSPACE_COMPOSER_PROMPTS);
        if (prompts && prompts.length > settings.limit) {
          await writeHistoryFile(workspace.id, prompts.slice(-settings.limit));
        }
      })
    );
    return settings;
  });
}

export async function listManagedWorkspaceComposerPrompts(workspaceId: string): Promise<WorkspaceComposerPrompt[]> {
  const stored = (await readWorkspaceStore()).workspaces.find((workspace) => workspace.id === workspaceId);
  if (!stored) throw new WorkspaceComposerHistoryError('not-found', 'Workspace was not found.');
  const settings = await readManagedWorkspaceComposerHistorySettings();
  return ((await readHistoryFile(workspaceId, settings.limit)) ?? []).map((prompt) => ({ ...prompt })).reverse();
}

export async function readManagedWorkspaceComposerPromptPreview(
  workspaceId: string
): Promise<WorkspaceComposerPromptPreview | null> {
  const settings = await readManagedWorkspaceComposerHistorySettings();
  if (!settings.enabled) return null;
  const history = (await readHistoryFile(workspaceId, settings.limit)) ?? [];
  return workspaceComposerPromptPreview(history);
}

export async function appendManagedWorkspaceComposerPrompt(
  workspaceId: string,
  value: unknown,
  submittedAt = Date.now()
): Promise<
  | { saved: false }
  | { saved: true; prompt: WorkspaceComposerPrompt; preview: WorkspaceComposerPromptPreview }
> {
  return withWorkspaceStoreMutation(async () => {
    const stored = (await readWorkspaceStore()).workspaces.find((workspace) => workspace.id === workspaceId);
    if (!stored) throw new WorkspaceComposerHistoryError('not-found', 'Workspace was not found.');
    const settings = await readManagedWorkspaceComposerHistorySettings();
    if (!settings.enabled) return { saved: false };
    const text = normalizeComposerPrompt(value);
    const prompt = { id: randomUUID(), text, submittedAt };
    const existing = (await readHistoryFile(workspaceId, settings.limit)) ?? [];
    const history = [...existing, prompt].slice(-settings.limit);
    await writeHistoryFile(workspaceId, history);
    return { saved: true, prompt, preview: workspaceComposerPromptPreview(history)! };
  });
}

export async function prepareManagedWorkspaceComposerHistoryRemoval(
  workspaceId: string
): Promise<() => Promise<void>> {
  const path = managedWorkspaceComposerHistoryPath(workspaceId);
  if ((await assertRegularFile(path, MAX_COMPOSER_HISTORY_FILE_BYTES)) === 'missing') return async () => undefined;
  return async () => {
    try {
      await unlink(path);
    } catch (error) {
      if (!errorHasCode(error, 'ENOENT')) throw error;
    }
  };
}

function mergedPromptHistory(
  legacy: WorkspaceComposerPrompt[],
  current: WorkspaceComposerPrompt[]
): WorkspaceComposerPrompt[] {
  const byId = new Map<string, WorkspaceComposerPrompt>();
  for (const prompt of [...legacy, ...current]) byId.set(prompt.id, prompt);
  return [...byId.values()]
    .sort((left, right) => left.submittedAt - right.submittedAt)
    .slice(-MAX_WORKSPACE_COMPOSER_PROMPTS);
}

export async function migrateManagedWorkspaceComposerHistories(): Promise<number> {
  return withWorkspaceStoreMutation(async () => {
    const state = await readWorkspaceStore();
    let rawState: unknown;
    try {
      rawState = await readWorkspaceStateFile();
    } catch {
      return 0;
    }
    const rawWorkspaces = isRecord(rawState)
      ? Array.isArray(rawState.workspaces)
        ? rawState.workspaces
        : Array.isArray(rawState.sessions)
          ? rawState.sessions
          : []
      : [];
    const legacyById = new Map<string, WorkspaceComposerPrompt[]>();
    let compatibilityCount = 0;
    for (const workspace of rawWorkspaces) {
      if (!isRecord(workspace) || typeof workspace.id !== 'string' || !('composerPromptHistory' in workspace)) continue;
      compatibilityCount += 1;
      legacyById.set(
        workspace.id,
        normalizeWorkspaceComposerPromptHistory(workspace.composerPromptHistory, MAX_WORKSPACE_COMPOSER_PROMPTS)
      );
    }
    if (compatibilityCount === 0) return 0;

    await Promise.all(
      state.workspaces.map(async (workspace) => {
        const legacy = legacyById.get(workspace.id);
        if (!legacy?.length) return;
        const current = (await readHistoryFile(workspace.id, MAX_WORKSPACE_COMPOSER_PROMPTS)) ?? [];
        await writeHistoryFile(workspace.id, mergedPromptHistory(legacy, current));
      })
    );
    await writeWorkspaceStore(state);
    return compatibilityCount;
  });
}
