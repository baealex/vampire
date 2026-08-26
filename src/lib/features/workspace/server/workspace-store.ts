import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { errorHasCode } from '~/lib/shared/server/path-policy.ts';
import { vampireStatePath } from '~/lib/shared/server/state-path.ts';
import {
  normalizeWorkspaceAutomations,
  type WorkspaceAutomation,
} from '~/lib/shared/contracts/workspace-automations.ts';
import { MAX_LAUNCH_PROFILES, normalizeLaunchProfiles } from '~/lib/shared/contracts/launch-profiles.ts';
import type { LaunchProfile, WorkspaceKingControl, WorkspacePreferences } from '~/lib/shared/contracts/workspace.ts';

export const WORKSPACE_STATE_VERSION = 1;
export const BACKGROUND_COMMAND_MAX_LENGTH = 1_000;
export const MAX_FAVORITE_COMMANDS = 16;

export interface StoredWorkspace {
  id: string;
  tmuxSession: string;
  cwd: string;
  workspaceKind?: 'directory' | 'worktree' | 'king';
  repositoryPath?: string;
  workspaceLabel?: string;
  worktreeBranch?: string;
  checkoutKey?: string;
  managedWorktree?: boolean;
  kingControl?: WorkspaceKingControl;
  createdAt: number;
  lastActiveAt: number;
  automations: WorkspaceAutomation[];
  favoriteCommands: string[];
  startupProfileId: string | null;
}

export interface WorkspaceStore {
  version: typeof WORKSPACE_STATE_VERSION;
  workspaces: StoredWorkspace[];
  launchProfiles: LaunchProfile[];
  workspacePreferences?: WorkspacePreferences;
}

export interface WorkspaceConnection {
  tmuxSession: string;
  cwd: string;
}

export function storedWorkspaceCheckoutKey(workspace: StoredWorkspace): string {
  return workspace.checkoutKey || workspace.cwd;
}

export function storedWorkspacesShareCheckout(left: StoredWorkspace, right: StoredWorkspace): boolean {
  return storedWorkspaceCheckoutKey(left) === storedWorkspaceCheckoutKey(right);
}

export function effectiveWorkspaceKingControl(
  workspaces: StoredWorkspace[],
  target: StoredWorkspace
): WorkspaceKingControl | undefined {
  const checkoutController = workspaces.find(
    (workspace) =>
      workspace.workspaceKind !== 'king' &&
      workspace.kingControl?.state === 'king' &&
      storedWorkspacesShareCheckout(workspace, target)
  );
  return checkoutController?.kingControl ?? target.kingControl;
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
    (value.workspaceKind === undefined ||
      value.workspaceKind === 'directory' ||
      value.workspaceKind === 'worktree' ||
      value.workspaceKind === 'king') &&
    (value.repositoryPath === undefined || typeof value.repositoryPath === 'string') &&
    (value.workspaceLabel === undefined || typeof value.workspaceLabel === 'string') &&
    (value.worktreeBranch === undefined || typeof value.worktreeBranch === 'string') &&
    (value.checkoutKey === undefined || typeof value.checkoutKey === 'string') &&
    (value.managedWorktree === undefined || typeof value.managedWorktree === 'boolean') &&
    (value.kingControl === undefined || isWorkspaceKingControl(value.kingControl)) &&
    typeof value.createdAt === 'number' &&
    (value.lastActiveAt === undefined || typeof value.lastActiveAt === 'number') &&
    (value.note === undefined || typeof value.note === 'string') &&
    (value.noteFile === undefined || typeof value.noteFile === 'boolean') &&
    (value.agentNoteFile === undefined || typeof value.agentNoteFile === 'boolean') &&
    (value.automations === undefined || Array.isArray(value.automations)) &&
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

function isWorkspaceKingControl(value: unknown): value is WorkspaceKingControl {
  return (
    isRecord(value) &&
    (value.state === 'manual' || value.state === 'requested' || value.state === 'king') &&
    typeof value.reason === 'string' &&
    (value.requestedAt === null || typeof value.requestedAt === 'number') &&
    typeof value.changedAt === 'number' &&
    (value.lastAction === 'requested' ||
      value.lastAction === 'granted' ||
      value.lastAction === 'declined' ||
      value.lastAction === 'released') &&
    (value.notifiedAt === null || typeof value.notifiedAt === 'number') &&
    (value.handoffSnapshot === undefined ||
      value.handoffSnapshot === null ||
      isWorkspaceHandoffSnapshot(value.handoffSnapshot))
  );
}

function isWorkspaceHandoffSnapshot(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.capturedAt === 'number' &&
    (value.checkoutKey === null || typeof value.checkoutKey === 'string') &&
    typeof value.isGitRepository === 'boolean' &&
    (value.headRevision === null || typeof value.headRevision === 'string') &&
    Array.isArray(value.changes) &&
    value.changes.every(isRepositoryChange) &&
    (value.changeFingerprints === null ||
      (Array.isArray(value.changeFingerprints) && value.changeFingerprints.every(isRepositoryChangeFingerprint))) &&
    (value.repositoryStateHash === null || typeof value.repositoryStateHash === 'string')
  );
}

function isRepositoryChange(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.path === 'string' &&
    typeof value.status === 'string' &&
    (value.previousPath === undefined || typeof value.previousPath === 'string')
  );
}

function isRepositoryChangeFingerprint(value: unknown): boolean {
  return isRepositoryChange(value) && isRecord(value) && typeof value.diffHash === 'string';
}

function normalizeWorkspaceKingControl(value: unknown): WorkspaceKingControl | undefined {
  if (!isWorkspaceKingControl(value)) return undefined;
  let handoffSnapshot: WorkspaceKingControl['handoffSnapshot'] = null;
  if (isWorkspaceHandoffSnapshot(value.handoffSnapshot)) {
    handoffSnapshot = structuredClone(value.handoffSnapshot) as WorkspaceKingControl['handoffSnapshot'];
  }
  return { ...structuredClone(value), handoffSnapshot };
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

function normalizeWorkspaceKind(workspace: Record<string, unknown>): StoredWorkspace['workspaceKind'] {
  if (workspace.workspaceKind === 'king') return 'king';
  if (workspace.workspaceKind === 'worktree' || typeof workspace.worktreeBranch === 'string') return 'worktree';
  if (workspace.workspaceKind === 'directory') return 'directory';
  return undefined;
}

function managedWorktreeOwnership(
  workspaceKind: StoredWorkspace['workspaceKind'],
  value: unknown
): Pick<StoredWorkspace, 'managedWorktree'> | Record<string, never> {
  if (workspaceKind !== 'worktree') return {};
  return { managedWorktree: value !== false };
}

function parseWorkspaceStore(value: unknown): WorkspaceStore {
  if (!isRecord(value)) throw new Error('invalid state file');
  const rawWorkspaces = value.workspaces ?? value.sessions;
  if (
    value.version !== WORKSPACE_STATE_VERSION ||
    !Array.isArray(rawWorkspaces) ||
    !rawWorkspaces.every(isStoredWorkspace) ||
    (value.launchProfiles !== undefined && !Array.isArray(value.launchProfiles))
  ) {
    throw new Error('invalid state file');
  }

  const workspacePreferences = normalizeWorkspacePreferences(value.workspacePreferences);
  const compatibility =
    value.launchProfiles === undefined ? migrateCompatibilityLaunchProfiles(rawWorkspaces) : undefined;
  const launchProfiles = compatibility?.launchProfiles ?? normalizeLaunchProfiles(value.launchProfiles);
  const launchProfileIds = new Set(launchProfiles.map((profile) => profile.id));
  return {
    version: WORKSPACE_STATE_VERSION,
    ...(workspacePreferences ? { workspacePreferences } : {}),
    launchProfiles,
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
      const workspaceKind = normalizeWorkspaceKind(workspace);
      const automations = normalizeWorkspaceAutomations(workspace.automations).filter(
        (automation) => automation.kind !== 'king-bootstrap' || workspaceKind === 'king'
      );
      const kingControl = normalizeWorkspaceKingControl(workspace.kingControl);
      return {
        id: workspace.id,
        tmuxSession: workspace.tmuxSession,
        cwd: workspace.cwd,
        ...(workspaceKind ? { workspaceKind } : {}),
        ...(typeof workspace.repositoryPath === 'string' ? { repositoryPath: workspace.repositoryPath } : {}),
        ...(typeof workspace.workspaceLabel === 'string' ? { workspaceLabel: workspace.workspaceLabel } : {}),
        ...(typeof workspace.worktreeBranch === 'string' ? { worktreeBranch: workspace.worktreeBranch } : {}),
        ...(typeof workspace.checkoutKey === 'string' ? { checkoutKey: workspace.checkoutKey } : {}),
        ...managedWorktreeOwnership(workspaceKind, workspace.managedWorktree),
        ...(kingControl ? { kingControl } : {}),
        createdAt: workspace.createdAt,
        lastActiveAt: typeof workspace.lastActiveAt === 'number' ? workspace.lastActiveAt : workspace.createdAt,
        automations,
        favoriteCommands: normalizeFavoriteCommands(workspace.favoriteCommands),
        startupProfileId,
      };
    }),
  };
}

export async function readWorkspaceStore(file = vampireStatePath()): Promise<WorkspaceStore> {
  try {
    return parseWorkspaceStore(await readWorkspaceStateFile(file));
  } catch (error) {
    if (errorHasCode(error, 'ENOENT')) return { version: WORKSPACE_STATE_VERSION, workspaces: [], launchProfiles: [] };
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
