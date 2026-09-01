import type {
  LaunchProfile,
  ManagedWorkspace,
  WorkspaceProcess,
  WorkspaceTerminal,
  WorkspacePreferences,
} from './workspace.ts';
import { isLaunchProfile } from './launch-profiles.ts';
import { isStatusPluginSnapshotList, type StatusPluginSnapshot } from './status-plugin.ts';

export type WorkspaceChanges = Partial<Omit<ManagedWorkspace, 'id'>>;

export type WorkspaceServerMessage =
  | {
      type: 'workspaces-snapshot';
      workspaces: ManagedWorkspace[];
      preferences?: WorkspacePreferences | null;
      launchProfiles?: LaunchProfile[];
      defaultStartupProfileId?: string | null;
    }
  | { type: 'status-plugins-snapshot'; plugins: StatusPluginSnapshot[] }
  | { type: 'workspace-added'; workspace: ManagedWorkspace }
  | { type: 'workspace-updated'; id: string; changes: WorkspaceChanges }
  | { type: 'workspace-removed'; id: string }
  | { type: 'workspace-preferences-updated'; preferences: WorkspacePreferences | null }
  | {
      type: 'launch-profiles-updated';
      launchProfiles: LaunchProfile[];
      defaultStartupProfileId?: string | null;
    }
  | { type: 'error'; message: string };

const WORKSPACE_CHANGE_FIELDS = new Set([
  'tmuxSession',
  'cwd',
  'workspaceKind',
  'repositoryPath',
  'workspaceLabel',
  'worktreeBranch',
  'createdAt',
  'lastActiveAt',
  'notePreview',
  'favoriteCommands',
  'startupProfileId',
  'state',
  'lastOutputAt',
  'attachedClients',
  'foregroundProcess',
  'terminals',
  'agentState',
  'isGitRepository',
  'workspaceAvailable',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isWorkspacePreferences(value: unknown): value is WorkspacePreferences {
  return (
    isRecord(value) &&
    (value.workspaceOrderMode === 'activity' || value.workspaceOrderMode === 'manual') &&
    Array.isArray(value.manualWorkspaceOrder) &&
    value.manualWorkspaceOrder.every((id) => typeof id === 'string')
  );
}

function isForegroundProcess(value: unknown): value is WorkspaceProcess | null {
  return (
    value === null ||
    (isRecord(value) && (value.kind === 'shell' || value.kind === 'command') && typeof value.label === 'string')
  );
}

function isWorkspaceTerminal(value: unknown): value is WorkspaceTerminal {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    /^@\d+$/.test(value.id) &&
    Number.isInteger(value.index) &&
    Number(value.index) >= 0 &&
    typeof value.name === 'string' &&
    typeof value.active === 'boolean' &&
    (value.lastOutputAt === null || isFiniteNumber(value.lastOutputAt)) &&
    isForegroundProcess(value.foregroundProcess) &&
    (value.command === null || typeof value.command === 'string') &&
    (value.startedAt === null || isFiniteNumber(value.startedAt)) &&
    (value.state === 'running' || value.state === 'exited') &&
    (value.exitCode === null || Number.isInteger(value.exitCode))
  );
}

/**
 * Older development servers sent only the terminal fields that existed before
 * background commands were introduced. Accept that shape for incremental
 * updates so a hot-reloaded client does not discard otherwise valid activity.
 *
 */
function isWorkspaceTerminalUpdate(
  value: unknown
): value is Partial<WorkspaceTerminal> &
  Pick<WorkspaceTerminal, 'id' | 'index' | 'name' | 'active' | 'lastOutputAt' | 'foregroundProcess'> {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    /^@\d+$/.test(value.id) &&
    Number.isInteger(value.index) &&
    Number(value.index) >= 0 &&
    typeof value.name === 'string' &&
    typeof value.active === 'boolean' &&
    (value.lastOutputAt === null || isFiniteNumber(value.lastOutputAt)) &&
    isForegroundProcess(value.foregroundProcess) &&
    (value.command === undefined || value.command === null || typeof value.command === 'string') &&
    (value.startedAt === undefined || value.startedAt === null || isFiniteNumber(value.startedAt)) &&
    (value.state === undefined || value.state === 'running' || value.state === 'exited') &&
    (value.exitCode === undefined || value.exitCode === null || Number.isInteger(value.exitCode))
  );
}

function normalizeWorkspaceChanges(value: WorkspaceChanges): WorkspaceChanges {
  if (!Array.isArray(value.terminals)) return value;
  const terminalUpdates = value.terminals as Array<Record<string, unknown>>;
  if (terminalUpdates.every(isWorkspaceTerminal)) return value;

  // A compatibility terminal array cannot safely replace the richer client-side
  // records because doing so would erase background command metadata. The
  // workspace timestamp represents the main terminal in that protocol, so keep
  // it and let the workspace store advance the main terminal from that value.
  const { terminals: _terminals, ...changes } = value;
  const mainOutputAt = terminalUpdates[0]?.lastOutputAt;
  if (changes.lastOutputAt === undefined && typeof mainOutputAt === 'number') {
    changes.lastOutputAt = mainOutputAt;
  }
  return changes;
}

export function isManagedWorkspaceMessage(value: unknown): value is ManagedWorkspace {
  return (
    isRecord(value) &&
    !('note' in value) &&
    !('noteFile' in value) &&
    !('automations' in value) &&
    typeof value.id === 'string' &&
    typeof value.tmuxSession === 'string' &&
    typeof value.cwd === 'string' &&
    (value.workspaceKind === undefined || value.workspaceKind === 'directory' || value.workspaceKind === 'worktree') &&
    (value.repositoryPath === undefined || typeof value.repositoryPath === 'string') &&
    (value.workspaceLabel === undefined || typeof value.workspaceLabel === 'string') &&
    (value.worktreeBranch === undefined || typeof value.worktreeBranch === 'string') &&
    isFiniteNumber(value.createdAt) &&
    isFiniteNumber(value.lastActiveAt) &&
    typeof value.notePreview === 'string' &&
    Array.isArray(value.favoriteCommands) &&
    value.favoriteCommands.every((command) => typeof command === 'string') &&
    (value.startupProfileId === null || typeof value.startupProfileId === 'string') &&
    (value.state === 'running' || value.state === 'missing') &&
    (value.lastOutputAt === null || isFiniteNumber(value.lastOutputAt)) &&
    Number.isInteger(value.attachedClients) &&
    Number(value.attachedClients) >= 0 &&
    isForegroundProcess(value.foregroundProcess) &&
    Array.isArray(value.terminals) &&
    value.terminals.every(isWorkspaceTerminal) &&
    (value.agentState === undefined ||
      value.agentState === null ||
      value.agentState === 'working' ||
      value.agentState === 'waiting') &&
    typeof value.isGitRepository === 'boolean' &&
    (value.workspaceAvailable === undefined || typeof value.workspaceAvailable === 'boolean')
  );
}

export function isWorkspaceChangesMessage(value: unknown): value is WorkspaceChanges {
  if (!isRecord(value) || Object.keys(value).some((key) => !WORKSPACE_CHANGE_FIELDS.has(key))) return false;
  return (
    (value.tmuxSession === undefined || typeof value.tmuxSession === 'string') &&
    (value.cwd === undefined || typeof value.cwd === 'string') &&
    (value.workspaceKind === undefined || value.workspaceKind === 'directory' || value.workspaceKind === 'worktree') &&
    (value.repositoryPath === undefined || typeof value.repositoryPath === 'string') &&
    (value.workspaceLabel === undefined || typeof value.workspaceLabel === 'string') &&
    (value.worktreeBranch === undefined || typeof value.worktreeBranch === 'string') &&
    (value.createdAt === undefined || isFiniteNumber(value.createdAt)) &&
    (value.lastActiveAt === undefined || isFiniteNumber(value.lastActiveAt)) &&
    (value.notePreview === undefined || typeof value.notePreview === 'string') &&
    (value.favoriteCommands === undefined ||
      (Array.isArray(value.favoriteCommands) &&
        value.favoriteCommands.every((command) => typeof command === 'string'))) &&
    (value.startupProfileId === undefined ||
      value.startupProfileId === null ||
      typeof value.startupProfileId === 'string') &&
    (value.state === undefined || value.state === 'running' || value.state === 'missing') &&
    (value.lastOutputAt === undefined || value.lastOutputAt === null || isFiniteNumber(value.lastOutputAt)) &&
    (value.attachedClients === undefined ||
      (Number.isInteger(value.attachedClients) && Number(value.attachedClients) >= 0)) &&
    (value.foregroundProcess === undefined || isForegroundProcess(value.foregroundProcess)) &&
    (value.terminals === undefined ||
      (Array.isArray(value.terminals) && value.terminals.every(isWorkspaceTerminalUpdate))) &&
    (value.agentState === undefined ||
      value.agentState === null ||
      value.agentState === 'working' ||
      value.agentState === 'waiting') &&
    (value.isGitRepository === undefined || typeof value.isGitRepository === 'boolean') &&
    (value.workspaceAvailable === undefined || typeof value.workspaceAvailable === 'boolean')
  );
}

export function parseWorkspaceServerMessage(value: unknown): WorkspaceServerMessage | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.type === 'workspaces-snapshot' &&
    Array.isArray(value.workspaces) &&
    value.workspaces.every(isManagedWorkspaceMessage) &&
    (value.preferences === undefined || value.preferences === null || isWorkspacePreferences(value.preferences)) &&
    (value.launchProfiles === undefined ||
      (Array.isArray(value.launchProfiles) && value.launchProfiles.every(isLaunchProfile))) &&
    (value.defaultStartupProfileId === undefined ||
      value.defaultStartupProfileId === null ||
      typeof value.defaultStartupProfileId === 'string')
  ) {
    return {
      type: 'workspaces-snapshot',
      workspaces: value.workspaces,
      ...(value.preferences !== undefined ? { preferences: value.preferences } : {}),
      ...(value.launchProfiles !== undefined ? { launchProfiles: value.launchProfiles } : {}),
      ...(value.defaultStartupProfileId !== undefined
        ? { defaultStartupProfileId: value.defaultStartupProfileId }
        : {}),
    };
  }
  if (value.type === 'status-plugins-snapshot' && isStatusPluginSnapshotList(value.plugins)) {
    return { type: 'status-plugins-snapshot', plugins: value.plugins };
  }
  if (value.type === 'workspace-added' && isManagedWorkspaceMessage(value.workspace)) {
    return { type: 'workspace-added', workspace: value.workspace };
  }
  if (value.type === 'workspace-updated' && typeof value.id === 'string' && isWorkspaceChangesMessage(value.changes)) {
    return { type: 'workspace-updated', id: value.id, changes: normalizeWorkspaceChanges(value.changes) };
  }
  if (value.type === 'workspace-removed' && typeof value.id === 'string') {
    return { type: 'workspace-removed', id: value.id };
  }
  if (
    value.type === 'workspace-preferences-updated' &&
    (value.preferences === null || isWorkspacePreferences(value.preferences))
  ) {
    return { type: 'workspace-preferences-updated', preferences: value.preferences };
  }
  if (
    value.type === 'launch-profiles-updated' &&
    Array.isArray(value.launchProfiles) &&
    value.launchProfiles.every(isLaunchProfile) &&
    (value.defaultStartupProfileId === undefined ||
      value.defaultStartupProfileId === null ||
      typeof value.defaultStartupProfileId === 'string')
  ) {
    return {
      type: 'launch-profiles-updated',
      launchProfiles: value.launchProfiles,
      ...(value.defaultStartupProfileId !== undefined
        ? { defaultStartupProfileId: value.defaultStartupProfileId }
        : {}),
    };
  }
  if (value.type === 'error' && typeof value.message === 'string') {
    return { type: 'error', message: value.message };
  }
  return undefined;
}

export function decodeWorkspaceServerMessage(raw: unknown): WorkspaceServerMessage | undefined {
  try {
    return parseWorkspaceServerMessage(JSON.parse(typeof raw === 'string' ? raw : String(raw)));
  } catch {
    return undefined;
  }
}

export function encodeWorkspaceServerMessage(message: WorkspaceServerMessage): string {
  const parsed = parseWorkspaceServerMessage(message);
  if (!parsed) throw new TypeError('Invalid workspace server message.');
  return JSON.stringify(parsed);
}
