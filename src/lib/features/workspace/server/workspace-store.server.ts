import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { errorHasCode } from '~/lib/server/path-policy.ts';
import { vampireStatePath } from '~/lib/server/state-path.ts';
import {
  normalizeWorkspaceAutomations,
  type WorkspaceAutomation,
} from '~/lib/shared/contracts/workspace-automations.ts';
import { MAX_LAUNCH_PROFILES, normalizeLaunchProfiles } from '~/lib/shared/contracts/launch-profiles.ts';
import type { LaunchProfile, WorkspacePreferences } from '~/lib/shared/contracts/workspace.ts';
import { isWorkspaceComposerTemplate } from '~/lib/shared/contracts/workspace-composer-template.ts';

export const WORKSPACE_STATE_VERSION = 1;
export const BACKGROUND_COMMAND_MAX_LENGTH = 1_000;
export const MAX_FAVORITE_COMMANDS = 16;

export interface StoredWorkspace {
  id: string;
  tmuxSession: string;
  cwd: string;
  workspaceKind?: 'directory' | 'worktree';
  repositoryPath?: string;
  workspaceLabel?: string;
  worktreeBranch?: string;
  createdAt: number;
  lastActiveAt: number;
  automations: WorkspaceAutomation[];
  favoriteCommands: string[];
  startupProfileId: string | null;
  composerTemplate?: string;
}

export interface WorkspaceStore {
  version: typeof WORKSPACE_STATE_VERSION;
  workspaces: StoredWorkspace[];
  launchProfiles: LaunchProfile[];
  defaultStartupProfileId?: string | null;
  workspacePreferences?: WorkspacePreferences;
}

export interface WorkspaceConnection {
  tmuxSession: string;
  cwd: string;
}

type WorkspaceStoreGlobal = typeof globalThis & {
  __vampireWorkspaceStoreMutationState?: { queue: Promise<void> };
};

const storeGlobal = globalThis as WorkspaceStoreGlobal;
const mutationState = (storeGlobal.__vampireWorkspaceStoreMutationState ??= {
  queue: Promise.resolve(),
});

export async function withWorkspaceStoreMutation<T>(operation: () => Promise<T>): Promise<T> {
  const previous = mutationState.queue;
  let release: () => void;
  mutationState.queue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release!();
  }
}

export async function readWorkspaceStateFile(file = vampireStatePath()): Promise<unknown> {
  return JSON.parse(await readFile(file, 'utf8')) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isStoredWorkspace(
  value: unknown
): value is Record<string, unknown> & Pick<StoredWorkspace, 'id' | 'tmuxSession' | 'cwd' | 'createdAt'> {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.tmuxSession === 'string' &&
    typeof value.cwd === 'string' &&
    (value.workspaceKind === undefined || value.workspaceKind === 'directory' || value.workspaceKind === 'worktree') &&
    (value.repositoryPath === undefined || typeof value.repositoryPath === 'string') &&
    (value.workspaceLabel === undefined || typeof value.workspaceLabel === 'string') &&
    (value.worktreeBranch === undefined || typeof value.worktreeBranch === 'string') &&
    typeof value.createdAt === 'number' &&
    (value.lastActiveAt === undefined || typeof value.lastActiveAt === 'number') &&
    (value.note === undefined || typeof value.note === 'string') &&
    (value.noteFile === undefined || typeof value.noteFile === 'boolean') &&
    (value.agentNoteFile === undefined || typeof value.agentNoteFile === 'boolean') &&
    (value.automations === undefined || Array.isArray(value.automations)) &&
    (value.composerPromptHistory === undefined || Array.isArray(value.composerPromptHistory)) &&
    (value.composerTemplate === undefined || isWorkspaceComposerTemplate(value.composerTemplate)) &&
    (value.favoriteCommands === undefined ||
      (Array.isArray(value.favoriteCommands) &&
        value.favoriteCommands.every((command) => typeof command === 'string'))) &&
    (value.startupProfileId === undefined ||
      value.startupProfileId === null ||
      typeof value.startupProfileId === 'string') &&
    (value.launchProfiles === undefined || Array.isArray(value.launchProfiles)) &&
    (value.defaultLaunchProfileId === undefined ||
      value.defaultLaunchProfileId === null ||
      typeof value.defaultLaunchProfileId === 'string') &&
    (value.autoStartDefaultProfile === undefined || typeof value.autoStartDefaultProfile === 'boolean')
  );
}

function uniqueLaunchProfileId(id: string, usedIds: Set<string>): string {
  if (!usedIds.has(id)) return id;
  let suffix = 2;
  while (true) {
    const suffixText = `-${suffix}`;
    const candidate = `${id.slice(0, 100 - suffixText.length)}${suffixText}`;
    if (!usedIds.has(candidate)) return candidate;
    suffix += 1;
  }
}

function migrateCompatibilityLaunchProfiles(workspaces: Array<Record<string, unknown>>): {
  launchProfiles: LaunchProfile[];
  profileIdsByWorkspace: Map<string, Map<string, string>>;
} {
  const launchProfiles: LaunchProfile[] = [];
  const profileIdsByWorkspace = new Map<string, Map<string, string>>();
  const globalIdByDefinition = new Map<string, string>();
  const usedIds = new Set<string>();

  for (const workspace of workspaces) {
    const profileIds = new Map<string, string>();
    for (const profile of normalizeLaunchProfiles(workspace.launchProfiles)) {
      const definition = `${profile.name}\0${profile.command}`;
      let globalId = globalIdByDefinition.get(definition);
      if (!globalId && launchProfiles.length < MAX_LAUNCH_PROFILES) {
        globalId = uniqueLaunchProfileId(profile.id, usedIds);
        usedIds.add(globalId);
        globalIdByDefinition.set(definition, globalId);
        launchProfiles.push({ ...profile, id: globalId });
      }
      if (globalId) profileIds.set(profile.id, globalId);
    }
    profileIdsByWorkspace.set(workspace.id as string, profileIds);
  }

  return { launchProfiles, profileIdsByWorkspace };
}

function normalizeFavoriteCommands(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((command): command is string => typeof command === 'string')
        .map((command) => command.trim())
        .filter(
          (command) =>
            command.length > 0 && command.length <= BACKGROUND_COMMAND_MAX_LENGTH && !/[\0\r\n\t]/.test(command)
        )
    ),
  ].slice(0, MAX_FAVORITE_COMMANDS);
}

function normalizeWorkspacePreferences(value: unknown): WorkspacePreferences | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error('invalid workspace preferences');
  }

  // Keep reading the pre-workspace naming from ~/.vampire/sessions.json.
  const workspaceOrderMode = value.workspaceOrderMode ?? value.sessionOrderMode;
  const manualWorkspaceOrder = value.manualWorkspaceOrder ?? value.manualSessionOrder;
  if (
    (workspaceOrderMode !== 'activity' && workspaceOrderMode !== 'manual') ||
    !Array.isArray(manualWorkspaceOrder) ||
    !manualWorkspaceOrder.every((id) => typeof id === 'string')
  ) {
    throw new Error('invalid workspace preferences');
  }
  return {
    workspaceOrderMode,
    manualWorkspaceOrder: [...new Set(manualWorkspaceOrder)],
  };
}

function parseWorkspaceStore(value: unknown): WorkspaceStore {
  if (!isRecord(value)) throw new Error('invalid state file');
  const rawWorkspaces = value.workspaces ?? value.sessions;
  if (
    value.version !== WORKSPACE_STATE_VERSION ||
    !Array.isArray(rawWorkspaces) ||
    !rawWorkspaces.every(isStoredWorkspace) ||
    (value.launchProfiles !== undefined && !Array.isArray(value.launchProfiles)) ||
    (value.defaultStartupProfileId !== undefined &&
      value.defaultStartupProfileId !== null &&
      typeof value.defaultStartupProfileId !== 'string')
  ) {
    throw new Error('invalid state file');
  }

  const workspacePreferences = normalizeWorkspacePreferences(value.workspacePreferences);
  const compatibility =
    value.launchProfiles === undefined ? migrateCompatibilityLaunchProfiles(rawWorkspaces) : undefined;
  const launchProfiles = compatibility?.launchProfiles ?? normalizeLaunchProfiles(value.launchProfiles);
  const launchProfileIds = new Set(launchProfiles.map((profile) => profile.id));
  const requestedDefaultStartupProfileId =
    typeof value.defaultStartupProfileId === 'string' ? value.defaultStartupProfileId.trim() : null;
  const defaultStartupProfileId =
    requestedDefaultStartupProfileId && launchProfileIds.has(requestedDefaultStartupProfileId)
      ? requestedDefaultStartupProfileId
      : null;
  return {
    version: WORKSPACE_STATE_VERSION,
    ...(workspacePreferences ? { workspacePreferences } : {}),
    launchProfiles,
    defaultStartupProfileId,
    workspaces: rawWorkspaces.map((workspace) => {
      const explicitStartupProfileId =
        typeof workspace.startupProfileId === 'string' ? workspace.startupProfileId.trim() : null;
      const compatibilityStartupProfileId =
        workspace.autoStartDefaultProfile === true && typeof workspace.defaultLaunchProfileId === 'string'
          ? (compatibility?.profileIdsByWorkspace.get(workspace.id)?.get(workspace.defaultLaunchProfileId) ??
            workspace.defaultLaunchProfileId)
          : null;
      const startupProfileId =
        explicitStartupProfileId && launchProfileIds.has(explicitStartupProfileId)
          ? explicitStartupProfileId
          : compatibilityStartupProfileId && launchProfileIds.has(compatibilityStartupProfileId)
            ? compatibilityStartupProfileId
            : null;
      const workspaceKind =
        workspace.workspaceKind === 'worktree' || typeof workspace.worktreeBranch === 'string'
          ? ('worktree' as const)
          : workspace.workspaceKind === 'directory'
            ? ('directory' as const)
            : undefined;
      return {
        id: workspace.id,
        tmuxSession: workspace.tmuxSession,
        cwd: workspace.cwd,
        ...(workspaceKind ? { workspaceKind } : {}),
        ...(typeof workspace.repositoryPath === 'string' ? { repositoryPath: workspace.repositoryPath } : {}),
        ...(typeof workspace.workspaceLabel === 'string' ? { workspaceLabel: workspace.workspaceLabel } : {}),
        ...(typeof workspace.worktreeBranch === 'string' ? { worktreeBranch: workspace.worktreeBranch } : {}),
        createdAt: workspace.createdAt,
        lastActiveAt: typeof workspace.lastActiveAt === 'number' ? workspace.lastActiveAt : workspace.createdAt,
        automations: normalizeWorkspaceAutomations(workspace.automations),
        favoriteCommands: normalizeFavoriteCommands(workspace.favoriteCommands),
        startupProfileId,
        ...(typeof workspace.composerTemplate === 'string' ? { composerTemplate: workspace.composerTemplate } : {}),
      };
    }),
  };
}

export async function readWorkspaceStore(file = vampireStatePath()): Promise<WorkspaceStore> {
  try {
    return parseWorkspaceStore(await readWorkspaceStateFile(file));
  } catch (error) {
    if (errorHasCode(error, 'ENOENT'))
      return {
        version: WORKSPACE_STATE_VERSION,
        workspaces: [],
        launchProfiles: [],
        defaultStartupProfileId: null,
      };
    throw new Error('Vampire workspace registry is unreadable; refusing to overwrite it.', { cause: error });
  }
}

export async function writeWorkspaceStore(state: WorkspaceStore, file = vampireStatePath()): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporaryFile = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporaryFile, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporaryFile, file);
}

export async function findWorkspaceConnection(id: string, file?: string): Promise<WorkspaceConnection | undefined> {
  try {
    const value = await readWorkspaceStateFile(file);
    if (!isRecord(value)) return undefined;
    const rawWorkspaces = value.workspaces ?? value.sessions;
    if (!Array.isArray(rawWorkspaces)) return undefined;
    const workspace = rawWorkspaces.find((candidate) => isRecord(candidate) && candidate.id === id);
    if (!isRecord(workspace) || typeof workspace.tmuxSession !== 'string' || typeof workspace.cwd !== 'string') {
      return undefined;
    }
    return { tmuxSession: workspace.tmuxSession, cwd: workspace.cwd };
  } catch {
    return undefined;
  }
}
