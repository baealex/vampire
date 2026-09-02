import type { LaunchProfile, WorkspacePreferences } from './workspace.ts';
import { parseWorkspaceStore, type StoredWorkspace, type WorkspaceStore } from './workspace-store.ts';
import type { WorkspaceAutomation } from './workspace-automations.ts';

export const WORKSPACE_PERSISTENCE_VERSION = 1;
const REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export type WorkspaceRegistryEntry = Pick<
  StoredWorkspace,
  | 'id'
  | 'tmuxSession'
  | 'cwd'
  | 'workspaceKind'
  | 'repositoryPath'
  | 'workspaceLabel'
  | 'worktreeBranch'
  | 'createdAt'
  | 'lastActiveAt'
>;

export type WorkspaceRegistryDocument = {
  version: typeof WORKSPACE_PERSISTENCE_VERSION;
  revision: string;
  workspaces: WorkspaceRegistryEntry[];
};

export type GlobalWorkspaceSettingsDocument = {
  version: typeof WORKSPACE_PERSISTENCE_VERSION;
  revision: string;
  workspacePreferences?: WorkspacePreferences;
};

export type LaunchProfileDocument = {
  version: typeof WORKSPACE_PERSISTENCE_VERSION;
  revision: string;
  launchProfiles: LaunchProfile[];
  defaultStartupProfileId: string | null;
};

export type WorkspaceSettingsDocument = {
  version: typeof WORKSPACE_PERSISTENCE_VERSION;
  revision: string;
  workspaceId: string;
  startupProfileId: string | null;
  composerTemplate?: string;
};

export type WorkspaceAutomationsDocument = {
  version: typeof WORKSPACE_PERSISTENCE_VERSION;
  revision: string;
  workspaceId: string;
  automations: WorkspaceAutomation[];
};

export type WorkspaceBackgroundDocument = {
  version: typeof WORKSPACE_PERSISTENCE_VERSION;
  revision: string;
  workspaceId: string;
  favoriteCommands: string[];
};

export type WorkspaceOwnedDocuments = {
  workspaceId: string;
  settings: WorkspaceSettingsDocument;
  automations: WorkspaceAutomationsDocument;
  background: WorkspaceBackgroundDocument;
};

export type WorkspacePersistenceDocuments = {
  registry: WorkspaceRegistryDocument;
  globalSettings: GlobalWorkspaceSettingsDocument;
  launchProfiles: LaunchProfileDocument;
  workspaces: WorkspaceOwnedDocuments[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function assertRevision(value: unknown, expected?: string): asserts value is string {
  if (typeof value !== 'string' || !REVISION_PATTERN.test(value) || (expected !== undefined && value !== expected)) {
    throw new Error('invalid workspace state revision');
  }
}

function assertDocument(
  value: unknown,
  revision?: string
): asserts value is Record<string, unknown> & {
  version: typeof WORKSPACE_PERSISTENCE_VERSION;
  revision: string;
} {
  if (!isRecord(value) || value.version !== WORKSPACE_PERSISTENCE_VERSION) {
    throw new Error('invalid workspace state document');
  }
  assertRevision(value.revision, revision);
}

function registryEntry(workspace: StoredWorkspace): WorkspaceRegistryEntry {
  return {
    id: workspace.id,
    tmuxSession: workspace.tmuxSession,
    cwd: workspace.cwd,
    ...(workspace.workspaceKind !== undefined ? { workspaceKind: workspace.workspaceKind } : {}),
    ...(workspace.repositoryPath !== undefined ? { repositoryPath: workspace.repositoryPath } : {}),
    ...(workspace.workspaceLabel !== undefined ? { workspaceLabel: workspace.workspaceLabel } : {}),
    ...(workspace.worktreeBranch !== undefined ? { worktreeBranch: workspace.worktreeBranch } : {}),
    createdAt: workspace.createdAt,
    lastActiveAt: workspace.lastActiveAt,
  };
}

export function createWorkspacePersistenceDocuments(
  value: WorkspaceStore,
  revision: string
): WorkspacePersistenceDocuments {
  assertRevision(revision);
  const state = parseWorkspaceStore(value);
  return {
    registry: {
      version: WORKSPACE_PERSISTENCE_VERSION,
      revision,
      workspaces: state.workspaces.map(registryEntry),
    },
    globalSettings: {
      version: WORKSPACE_PERSISTENCE_VERSION,
      revision,
      ...(state.workspacePreferences ? { workspacePreferences: { ...state.workspacePreferences } } : {}),
    },
    launchProfiles: {
      version: WORKSPACE_PERSISTENCE_VERSION,
      revision,
      launchProfiles: state.launchProfiles.map((profile) => ({ ...profile })),
      defaultStartupProfileId: state.defaultStartupProfileId ?? null,
    },
    workspaces: state.workspaces.map((workspace) => ({
      workspaceId: workspace.id,
      settings: {
        version: WORKSPACE_PERSISTENCE_VERSION,
        revision,
        workspaceId: workspace.id,
        startupProfileId: workspace.startupProfileId,
        ...(workspace.composerTemplate !== undefined ? { composerTemplate: workspace.composerTemplate } : {}),
      },
      automations: {
        version: WORKSPACE_PERSISTENCE_VERSION,
        revision,
        workspaceId: workspace.id,
        automations: workspace.automations.map((automation) => ({
          ...automation,
          schedule: { ...automation.schedule },
        })),
      },
      background: {
        version: WORKSPACE_PERSISTENCE_VERSION,
        revision,
        workspaceId: workspace.id,
        favoriteCommands: [...workspace.favoriteCommands],
      },
    })),
  };
}

export function parseWorkspacePersistenceDocuments(value: {
  registry: unknown;
  globalSettings: unknown;
  launchProfiles: unknown;
  workspaces: Array<{ workspaceId: string; settings: unknown; automations: unknown; background: unknown }>;
}): WorkspaceStore {
  assertDocument(value.registry);
  const revision = value.registry.revision;
  assertDocument(value.globalSettings, revision);
  assertDocument(value.launchProfiles, revision);
  if (
    !hasOnlyKeys(value.registry, ['version', 'revision', 'workspaces']) ||
    !hasOnlyKeys(value.globalSettings, ['version', 'revision', 'workspacePreferences']) ||
    !hasOnlyKeys(value.launchProfiles, ['version', 'revision', 'launchProfiles', 'defaultStartupProfileId']) ||
    !Array.isArray(value.registry.workspaces) ||
    !Array.isArray(value.launchProfiles.launchProfiles)
  ) {
    throw new Error('invalid workspace persistence document');
  }

  const ownedById = new Map(value.workspaces.map((workspace) => [workspace.workspaceId, workspace]));
  if (ownedById.size !== value.workspaces.length) throw new Error('duplicate workspace persistence document');
  const workspaces = value.registry.workspaces.map((registryWorkspace) => {
    if (
      !isRecord(registryWorkspace) ||
      !hasOnlyKeys(registryWorkspace, [
        'id',
        'tmuxSession',
        'cwd',
        'workspaceKind',
        'repositoryPath',
        'workspaceLabel',
        'worktreeBranch',
        'createdAt',
        'lastActiveAt',
      ]) ||
      typeof registryWorkspace.id !== 'string' ||
      registryWorkspace.id.length === 0 ||
      registryWorkspace.id.length > 1_024
    ) {
      throw new Error('invalid workspace registry entry');
    }
    const owned = ownedById.get(registryWorkspace.id);
    if (!owned) throw new Error(`workspace state is missing for ${registryWorkspace.id}`);
    assertDocument(owned.settings, revision);
    assertDocument(owned.automations, revision);
    assertDocument(owned.background, revision);
    if (
      !hasOnlyKeys(owned.settings, ['version', 'revision', 'workspaceId', 'startupProfileId', 'composerTemplate']) ||
      !hasOnlyKeys(owned.automations, ['version', 'revision', 'workspaceId', 'automations']) ||
      !hasOnlyKeys(owned.background, ['version', 'revision', 'workspaceId', 'favoriteCommands']) ||
      owned.settings.workspaceId !== registryWorkspace.id ||
      owned.automations.workspaceId !== registryWorkspace.id ||
      owned.background.workspaceId !== registryWorkspace.id ||
      !Array.isArray(owned.automations.automations) ||
      !Array.isArray(owned.background.favoriteCommands)
    ) {
      throw new Error(`workspace state does not match ${registryWorkspace.id}`);
    }
    ownedById.delete(registryWorkspace.id);
    return {
      ...registryWorkspace,
      startupProfileId: owned.settings.startupProfileId,
      ...(typeof owned.settings.composerTemplate === 'string'
        ? { composerTemplate: owned.settings.composerTemplate }
        : {}),
      automations: owned.automations.automations,
      favoriteCommands: owned.background.favoriteCommands,
    };
  });
  if (ownedById.size > 0) throw new Error('workspace state contains entries absent from the registry');

  return parseWorkspaceStore({
    version: 1,
    workspaces,
    launchProfiles: value.launchProfiles.launchProfiles,
    defaultStartupProfileId: value.launchProfiles.defaultStartupProfileId,
    ...(value.globalSettings.workspacePreferences !== undefined
      ? { workspacePreferences: value.globalSettings.workspacePreferences }
      : {}),
  });
}
