import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import {
  captureTmuxBackgroundOutput,
  createTmuxSession,
  createTmuxBackgroundProcess,
  killTmuxBackgroundProcess,
  killTmuxSession,
  listTmuxSessions,
  sendTmuxInput,
  type TmuxProcessHint,
  type TmuxSession,
  type TmuxTerminal,
} from '~/lib/features/terminal/server/tmux.server.ts';
import { isGitRepository as readIsGitRepository } from '~/lib/features/repository/server/repository.server.ts';
import {
  ensureManagedWorkspaceNoteFile,
  prepareManagedWorkspaceNoteRemoval,
  readManagedWorkspaceNoteFile,
  writeManagedWorkspaceNoteFile,
} from '~/lib/features/workspace/server/workspace-note-file.server.ts';
import { createWorkspaceNotePreview } from '~/lib/features/workspace/server/workspace-note.server.ts';
import { prepareWorkspaceAutomationRequestRemoval } from '~/lib/features/workspace/server/workspace-automation-request-files.server.ts';
import {
  BACKGROUND_COMMAND_MAX_LENGTH,
  MAX_FAVORITE_COMMANDS,
  readWorkspaceStore as readState,
  type StoredWorkspace,
  withWorkspaceStoreMutation,
  writeWorkspaceStore as writeState,
} from '~/lib/features/workspace/server/workspace-store.server.ts';
import {
  resolveAllowedWorkspaceDirectory,
  resolveExistingWorkspaceDirectory,
  WorkspaceRootError,
} from '~/lib/features/system/server/workspace-roots.server.ts';
import {
  createGitWorktree,
  GitWorktreeError,
  removeManagedGitWorktree,
  rollbackGitWorktree,
} from '~/lib/features/repository/server/git-worktree.server.ts';
import type { AgentState } from '~/lib/shared/contracts/workspace-agent.ts';
import { isLaunchProfileList, normalizeLaunchProfiles } from '~/lib/shared/contracts/launch-profiles.ts';
import type { LaunchProfile, LaunchProfileSettings, WorkspacePreferences } from '~/lib/shared/contracts/workspace.ts';

export const WORKSPACE_ALIAS_MAX_LENGTH = 80;
export const MAX_BACKGROUND_PROCESSES = 8;
export { BACKGROUND_COMMAND_MAX_LENGTH, MAX_FAVORITE_COMMANDS };

export interface ManagedWorkspace extends Omit<StoredWorkspace, 'automations'> {
  notePreview: string;
  state: 'running' | 'missing';
  lastOutputAt: number | null;
  attachedClients: number;
  foregroundProcess: TmuxProcessHint | null;
  terminals: TmuxTerminal[];
  agentState: AgentState;
  isGitRepository: boolean;
  workspaceAvailable: boolean;
}

export type WorkspaceLaunchErrorReason = 'invalid-cwd' | 'tmux-launch-failed';

export class WorkspaceLaunchError extends Error {
  readonly reason: WorkspaceLaunchErrorReason;

  constructor(reason: WorkspaceLaunchErrorReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

export type WorkspaceMutationErrorReason =
  | 'not-found'
  | 'workspace-running'
  | 'workspace-not-running'
  | 'worktree-cleanup-failed'
  | 'invalid-background-command'
  | 'background-not-found'
  | 'background-limit'
  | 'favorite-limit'
  | 'invalid-launch-profiles'
  | 'invalid-startup-profile'
  | 'invalid-workspace-alias'
  | 'invalid-workspace-preferences';

export class WorkspaceMutationError extends Error {
  readonly reason: WorkspaceMutationErrorReason;

  constructor(reason: WorkspaceMutationErrorReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

async function validateCwd(cwd: string): Promise<string> {
  try {
    return await resolveAllowedWorkspaceDirectory(cwd);
  } catch (cause) {
    if (cause instanceof WorkspaceRootError) throw new WorkspaceLaunchError('invalid-cwd', cause.message);
    throw new WorkspaceLaunchError('invalid-cwd', 'Working directory does not exist or is not a permitted workspace.');
  }
}

async function validateExistingCwd(cwd: string): Promise<string> {
  try {
    return await resolveExistingWorkspaceDirectory(cwd);
  } catch (cause) {
    if (cause instanceof WorkspaceRootError) throw new WorkspaceLaunchError('invalid-cwd', cause.message);
    throw new WorkspaceLaunchError('invalid-cwd', 'Working directory does not exist or is not a directory.');
  }
}

async function initializeManagedWorkspaceNote(stored: StoredWorkspace): Promise<void> {
  await ensureManagedWorkspaceNoteFile(stored.id, '');
}

async function readManagedWorkspaceNotePreview(stored: StoredWorkspace): Promise<string> {
  try {
    return createWorkspaceNotePreview((await readManagedWorkspaceNoteFile(stored.id)) ?? '');
  } catch {
    return '';
  }
}

function isValidBackgroundCommand(command: string): boolean {
  return Boolean(command) && command.length <= BACKGROUND_COMMAND_MAX_LENGTH && !/[\0\r\n\t]/.test(command);
}

function normalizeBackgroundCommand(command: string): string {
  const normalizedCommand = command.trim();
  if (!isValidBackgroundCommand(normalizedCommand)) {
    throw new WorkspaceMutationError('invalid-background-command', 'Enter a single-line background command.');
  }
  return normalizedCommand;
}

async function detectGitRepository(cwd: string): Promise<boolean> {
  try {
    return await readIsGitRepository(cwd);
  } catch {
    return false;
  }
}

async function detectWorkspaceAvailable(cwd: string): Promise<boolean> {
  try {
    return (await stat(cwd)).isDirectory();
  } catch {
    return false;
  }
}

function reconcileWorkspacePreferences(
  workspaces: StoredWorkspace[],
  preferences: WorkspacePreferences
): WorkspacePreferences {
  const workspaceIds = new Set(workspaces.map((workspace) => workspace.id));
  const manualWorkspaceOrder = [...new Set(preferences.manualWorkspaceOrder)].filter((id) => workspaceIds.has(id));
  const orderedIds = new Set(manualWorkspaceOrder);
  for (const workspace of workspaces) {
    if (!orderedIds.has(workspace.id)) manualWorkspaceOrder.push(workspace.id);
  }
  return {
    workspaceOrderMode: preferences.workspaceOrderMode,
    manualWorkspaceOrder,
  };
}

function validateWorkspacePreferences(input: WorkspacePreferences): WorkspacePreferences {
  if (
    (input.workspaceOrderMode !== 'activity' && input.workspaceOrderMode !== 'manual') ||
    !Array.isArray(input.manualWorkspaceOrder) ||
    !input.manualWorkspaceOrder.every((id) => typeof id === 'string')
  ) {
    throw new WorkspaceMutationError('invalid-workspace-preferences', 'Workspace order preferences are invalid.');
  }
  return {
    workspaceOrderMode: input.workspaceOrderMode,
    manualWorkspaceOrder: [...new Set(input.manualWorkspaceOrder)],
  };
}

function normalizeWorkspaceAlias(alias: string): string {
  const normalizedAlias = alias.trim();
  if (normalizedAlias.length > WORKSPACE_ALIAS_MAX_LENGTH || /[\0\r\n\t]/.test(normalizedAlias)) {
    throw new WorkspaceMutationError(
      'invalid-workspace-alias',
      `Workspace aliases must stay on one line and be ${WORKSPACE_ALIAS_MAX_LENGTH} characters or fewer.`
    );
  }
  return normalizedAlias;
}

const exclusively = withWorkspaceStoreMutation;

export async function listManagedWorkspaces(): Promise<ManagedWorkspace[]> {
  const [state, tmuxSessions] = await Promise.all([readState(), listTmuxSessions()]);
  const workspaceStates = await Promise.all(
    [...new Set(state.workspaces.map((workspace) => workspace.cwd))].map(
      async (cwd): Promise<[string, boolean, boolean]> => {
        const [isGitRepository, workspaceAvailable] = await Promise.all([
          detectGitRepository(cwd),
          detectWorkspaceAvailable(cwd),
        ]);
        return [cwd, isGitRepository, workspaceAvailable];
      }
    )
  );
  const repositoryByCwd = new Map(workspaceStates.map(([cwd, isGitRepository]) => [cwd, isGitRepository]));
  const availabilityByCwd = new Map(workspaceStates.map(([cwd, , workspaceAvailable]) => [cwd, workspaceAvailable]));
  const tmuxByName = new Map(tmuxSessions.map((workspace) => [workspace.name, workspace]));
  const notePreviews = await Promise.all(
    state.workspaces.map((workspace) => readManagedWorkspaceNotePreview(workspace))
  );

  return state.workspaces.map((workspace, index) => {
    const tmux = tmuxByName.get(workspace.tmuxSession);
    const { automations: _automations, ...stored } = workspace;
    return {
      ...stored,
      notePreview: notePreviews[index] ?? '',
      state: tmux ? 'running' : 'missing',
      lastOutputAt: tmux?.lastOutputAt ?? null,
      attachedClients: tmux?.attachedClients ?? 0,
      foregroundProcess: tmux?.foregroundProcess ?? null,
      terminals: tmux?.terminals ?? [],
      agentState: null,
      isGitRepository: repositoryByCwd.get(workspace.cwd) ?? false,
      workspaceAvailable: availabilityByCwd.get(workspace.cwd) ?? false,
    };
  });
}

export async function findManagedWorkspace(id: string): Promise<ManagedWorkspace | undefined> {
  return (await listManagedWorkspaces()).find((workspace) => workspace.id === id);
}

export async function readManagedWorkspacePreferences(): Promise<WorkspacePreferences | null> {
  const state = await readState();
  return state.workspacePreferences
    ? reconcileWorkspacePreferences(state.workspaces, state.workspacePreferences)
    : null;
}

export async function readManagedLaunchProfiles(): Promise<LaunchProfile[]> {
  return (await readState()).launchProfiles;
}

export async function readManagedLaunchProfileSettings(): Promise<LaunchProfileSettings> {
  const state = await readState();
  return {
    launchProfiles: state.launchProfiles,
    defaultStartupProfileId: state.defaultStartupProfileId ?? null,
  };
}

export async function updateManagedWorkspacePreferences(input: WorkspacePreferences): Promise<WorkspacePreferences> {
  return exclusively(async () => {
    const state = await readState();
    const workspacePreferences = reconcileWorkspacePreferences(state.workspaces, validateWorkspacePreferences(input));
    await writeState({ ...state, workspacePreferences });
    return workspacePreferences;
  });
}

export async function findWorkspaceDirectory(id: string): Promise<Pick<StoredWorkspace, 'id' | 'cwd'> | undefined> {
  const workspace = (await readState()).workspaces.find((candidate) => candidate.id === id);
  return workspace ? { id: workspace.id, cwd: workspace.cwd } : undefined;
}

export async function createManagedWorkspace(input: { cwd: string }): Promise<ManagedWorkspace> {
  return exclusively(async () => {
    const cwd = await validateCwd(input.cwd);
    const gitRepository = await detectGitRepository(cwd);
    const current = await readState();
    const id = randomUUID();
    const stored: StoredWorkspace = {
      id,
      tmuxSession: `vampire-${id.slice(0, 8)}`,
      cwd,
      workspaceKind: 'directory',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      automations: [],
      favoriteCommands: [],
      startupProfileId: current.defaultStartupProfileId ?? null,
    };
    await initializeManagedWorkspaceNote(stored);
    await writeState({ ...current, workspaces: [...current.workspaces, stored] });

    let tmux;
    try {
      tmux = await createTmuxSession(stored.tmuxSession, cwd);
    } catch {
      const afterFailure = await readState();
      await writeState({
        ...afterFailure,
        workspaces: afterFailure.workspaces.filter((workspace) => workspace.id !== stored.id),
      });
      throw new WorkspaceLaunchError('tmux-launch-failed', 'tmux could not start the shell workspace.');
    }
    if (stored.startupProfileId) {
      try {
        await sendLaunchProfile(stored.tmuxSession, tmux, current.launchProfiles, stored.startupProfileId);
      } catch {
        // Keep the new shell available when an optional auto-start command cannot be sent.
      }
    }

    return {
      id: stored.id,
      tmuxSession: stored.tmuxSession,
      cwd: stored.cwd,
      workspaceKind: stored.workspaceKind,
      repositoryPath: stored.repositoryPath,
      workspaceLabel: stored.workspaceLabel,
      worktreeBranch: stored.worktreeBranch,
      createdAt: stored.createdAt,
      lastActiveAt: stored.lastActiveAt,
      favoriteCommands: stored.favoriteCommands,
      startupProfileId: stored.startupProfileId,
      notePreview: '',
      state: 'running',
      lastOutputAt: tmux.lastOutputAt,
      attachedClients: tmux.attachedClients,
      foregroundProcess: tmux.foregroundProcess,
      terminals: tmux.terminals,
      agentState: null,
      isGitRepository: gitRepository,
      workspaceAvailable: true,
    };
  });
}

export async function createManagedWorktreeWorkspace(input: {
  sourceWorkspaceId: string;
  name: string;
}): Promise<ManagedWorkspace> {
  return exclusively(async () => {
    const current = await readState();
    const source = current.workspaces.find((workspace) => workspace.id === input.sourceWorkspaceId);
    if (!source) throw new WorkspaceMutationError('not-found', 'Source workspace was not found.');

    const id = randomUUID();
    const worktree = await createGitWorktree(source.cwd, input.name, { id });
    const now = Date.now();
    const stored: StoredWorkspace = {
      id,
      tmuxSession: `vampire-${id.slice(0, 8)}`,
      cwd: worktree.cwd,
      workspaceKind: 'worktree',
      repositoryPath: source.repositoryPath ?? worktree.sourceRoot,
      workspaceLabel: worktree.label,
      worktreeBranch: worktree.branch,
      createdAt: now,
      lastActiveAt: now,
      automations: [],
      favoriteCommands: [...source.favoriteCommands],
      startupProfileId: source.startupProfileId,
    };
    try {
      await initializeManagedWorkspaceNote(stored);
      await writeState({ ...current, workspaces: [...current.workspaces, stored] });
    } catch (error) {
      await rollbackGitWorktree(worktree);
      throw error;
    }

    let tmux;
    try {
      tmux = await createTmuxSession(stored.tmuxSession, stored.cwd);
    } catch {
      const afterFailure = await readState();
      await writeState({
        ...afterFailure,
        workspaces: afterFailure.workspaces.filter((workspace) => workspace.id !== stored.id),
      });
      await rollbackGitWorktree(worktree);
      throw new WorkspaceLaunchError('tmux-launch-failed', 'tmux could not start the isolated workspace shell.');
    }
    if (stored.startupProfileId) {
      try {
        await sendLaunchProfile(stored.tmuxSession, tmux, current.launchProfiles, stored.startupProfileId);
      } catch {
        // Keep the new shell available when an optional auto-start command cannot be sent.
      }
    }

    return {
      id: stored.id,
      tmuxSession: stored.tmuxSession,
      cwd: stored.cwd,
      workspaceKind: stored.workspaceKind,
      repositoryPath: stored.repositoryPath,
      workspaceLabel: stored.workspaceLabel,
      worktreeBranch: stored.worktreeBranch,
      createdAt: stored.createdAt,
      lastActiveAt: stored.lastActiveAt,
      favoriteCommands: stored.favoriteCommands,
      startupProfileId: stored.startupProfileId,
      notePreview: '',
      state: 'running',
      lastOutputAt: tmux.lastOutputAt,
      attachedClients: tmux.attachedClients,
      foregroundProcess: tmux.foregroundProcess,
      terminals: tmux.terminals,
      agentState: null,
      isGitRepository: true,
      workspaceAvailable: true,
    };
  });
}

export async function restartManagedWorkspace(
  id: string,
  input: { launchProfileId?: string | null } = {}
): Promise<ManagedWorkspace> {
  return exclusively(async () => {
    const state = await readState();
    const index = state.workspaces.findIndex((workspace) => workspace.id === id);
    if (index < 0) throw new WorkspaceMutationError('not-found', 'Workspace was not found.');

    const stored = state.workspaces[index];
    const launchProfileId = resolveRestartProfileId(stored, state.launchProfiles, input.launchProfileId);
    const existingTmux = (await listTmuxSessions()).find((workspace) => workspace.name === stored.tmuxSession);
    if (existingTmux) {
      const [gitRepository, workspaceAvailable] = await Promise.all([
        detectGitRepository(stored.cwd),
        detectWorkspaceAvailable(stored.cwd),
      ]);
      return {
        id: stored.id,
        tmuxSession: stored.tmuxSession,
        cwd: stored.cwd,
        workspaceKind: stored.workspaceKind,
        repositoryPath: stored.repositoryPath,
        workspaceLabel: stored.workspaceLabel,
        worktreeBranch: stored.worktreeBranch,
        createdAt: stored.createdAt,
        lastActiveAt: stored.lastActiveAt,
        favoriteCommands: stored.favoriteCommands,
        startupProfileId: stored.startupProfileId,
        notePreview: await readManagedWorkspaceNotePreview(stored),
        state: 'running',
        lastOutputAt: existingTmux.lastOutputAt,
        attachedClients: existingTmux.attachedClients,
        foregroundProcess: existingTmux.foregroundProcess,
        terminals: existingTmux.terminals,
        agentState: null,
        isGitRepository: gitRepository,
        workspaceAvailable,
      };
    }

    const cwd = await validateExistingCwd(stored.cwd);
    const gitRepository = await detectGitRepository(cwd);
    let restartedTmux;
    try {
      restartedTmux = await createTmuxSession(stored.tmuxSession, cwd);
    } catch {
      throw new WorkspaceLaunchError('tmux-launch-failed', 'tmux could not restart the shell workspace.');
    }

    const restarted = { ...stored, cwd, createdAt: Date.now(), lastActiveAt: Date.now() };
    const workspaces = [...state.workspaces];
    workspaces[index] = restarted;
    await writeState({ ...state, workspaces });
    if (launchProfileId) {
      try {
        await sendLaunchProfile(restarted.tmuxSession, restartedTmux, state.launchProfiles, launchProfileId);
      } catch {
        // Keep the shell available when an optional auto-start command cannot be sent.
      }
    }
    return {
      id: restarted.id,
      tmuxSession: restarted.tmuxSession,
      cwd: restarted.cwd,
      workspaceKind: restarted.workspaceKind,
      repositoryPath: restarted.repositoryPath,
      workspaceLabel: restarted.workspaceLabel,
      worktreeBranch: restarted.worktreeBranch,
      createdAt: restarted.createdAt,
      lastActiveAt: restarted.lastActiveAt,
      favoriteCommands: restarted.favoriteCommands,
      startupProfileId: restarted.startupProfileId,
      notePreview: await readManagedWorkspaceNotePreview(restarted),
      state: 'running',
      lastOutputAt: restartedTmux.lastOutputAt,
      attachedClients: restartedTmux.attachedClients,
      foregroundProcess: restartedTmux.foregroundProcess,
      terminals: restartedTmux.terminals,
      agentState: null,
      isGitRepository: gitRepository,
      workspaceAvailable: true,
    };
  });
}

function validateLaunchProfiles(input: LaunchProfile[]): LaunchProfile[] {
  if (!isLaunchProfileList(input)) {
    throw new WorkspaceMutationError(
      'invalid-launch-profiles',
      'Launch profiles must contain valid names and single-line commands.'
    );
  }
  const launchProfiles = normalizeLaunchProfiles(input);
  const normalizedNames = launchProfiles.map((profile) => profile.name.toLocaleLowerCase());
  if (new Set(normalizedNames).size !== normalizedNames.length) {
    throw new WorkspaceMutationError('invalid-launch-profiles', 'Launch profile names must be unique.');
  }
  return launchProfiles;
}

export type LaunchProfileUpdate = {
  launchProfiles: LaunchProfile[];
  defaultStartupProfileId: string | null;
  clearedWorkspaceIds: string[];
  workspaceStartupUpdates: Array<{ id: string; startupProfileId: string | null }>;
};

export type WorkspaceStartupUpdate = LaunchProfileUpdate & {
  startupProfileId: string | null;
};

export async function updateManagedLaunchProfiles(
  input: LaunchProfile[],
  options: { defaultStartupProfileId?: string | null; applyDefaultToAll?: boolean } = {}
): Promise<LaunchProfileUpdate> {
  return exclusively(async () => {
    const launchProfiles = validateLaunchProfiles(input);
    const state = await readState();
    const profileIds = new Set(launchProfiles.map((profile) => profile.id));
    const explicitDefault = options.defaultStartupProfileId;
    let defaultStartupProfileId =
      explicitDefault === undefined ? (state.defaultStartupProfileId ?? null) : (explicitDefault?.trim() ?? null);
    if (defaultStartupProfileId && !profileIds.has(defaultStartupProfileId)) {
      if (explicitDefault !== undefined) {
        throw new WorkspaceMutationError('invalid-startup-profile', 'The default startup profile was not found.');
      }
      defaultStartupProfileId = null;
    }
    const clearedWorkspaceIds: string[] = [];
    const workspaceStartupUpdates: Array<{ id: string; startupProfileId: string | null }> = [];
    const workspaces = state.workspaces.map((workspace) => {
      const startupProfileId = options.applyDefaultToAll
        ? defaultStartupProfileId
        : workspace.startupProfileId && profileIds.has(workspace.startupProfileId)
          ? workspace.startupProfileId
          : null;
      if (startupProfileId === workspace.startupProfileId) return workspace;
      if (startupProfileId === null) clearedWorkspaceIds.push(workspace.id);
      workspaceStartupUpdates.push({ id: workspace.id, startupProfileId });
      return { ...workspace, startupProfileId };
    });
    await writeState({ ...state, launchProfiles, defaultStartupProfileId, workspaces });
    return { launchProfiles, defaultStartupProfileId, clearedWorkspaceIds, workspaceStartupUpdates };
  });
}

export async function updateManagedStartupProfile(id: string, input: string | null): Promise<string | null> {
  return exclusively(async () => {
    const state = await readState();
    const index = state.workspaces.findIndex((workspace) => workspace.id === id);
    if (index < 0) throw new WorkspaceMutationError('not-found', 'Workspace was not found.');
    const startupProfileId = input?.trim() ?? null;
    if (startupProfileId !== null && !state.launchProfiles.some((profile) => profile.id === startupProfileId)) {
      throw new WorkspaceMutationError('invalid-startup-profile', 'The startup profile was not found.');
    }
    const workspaces = [...state.workspaces];
    workspaces[index] = { ...workspaces[index], startupProfileId };
    await writeState({ ...state, workspaces });
    return startupProfileId;
  });
}

export async function updateManagedWorkspaceStartup(
  id: string,
  input: { launchProfiles: LaunchProfile[]; startupProfileId: string | null }
): Promise<WorkspaceStartupUpdate> {
  return exclusively(async () => {
    const launchProfiles = validateLaunchProfiles(input.launchProfiles);
    const state = await readState();
    if (!state.workspaces.some((workspace) => workspace.id === id)) {
      throw new WorkspaceMutationError('not-found', 'Workspace was not found.');
    }
    const startupProfileId = input.startupProfileId?.trim() ?? null;
    const profileIds = new Set(launchProfiles.map((profile) => profile.id));
    if (startupProfileId !== null && !profileIds.has(startupProfileId)) {
      throw new WorkspaceMutationError('invalid-startup-profile', 'The startup profile was not found.');
    }

    const clearedWorkspaceIds: string[] = [];
    const workspaceStartupUpdates: Array<{ id: string; startupProfileId: string | null }> = [];
    const workspaces = state.workspaces.map((workspace) => {
      if (workspace.id === id) {
        if (workspace.startupProfileId !== startupProfileId) {
          workspaceStartupUpdates.push({ id: workspace.id, startupProfileId });
        }
        return { ...workspace, startupProfileId };
      }
      if (!workspace.startupProfileId || profileIds.has(workspace.startupProfileId)) return workspace;
      clearedWorkspaceIds.push(workspace.id);
      workspaceStartupUpdates.push({ id: workspace.id, startupProfileId: null });
      return { ...workspace, startupProfileId: null };
    });
    const defaultStartupProfileId =
      state.defaultStartupProfileId && profileIds.has(state.defaultStartupProfileId)
        ? state.defaultStartupProfileId
        : null;
    await writeState({ ...state, launchProfiles, defaultStartupProfileId, workspaces });
    return {
      launchProfiles,
      defaultStartupProfileId,
      startupProfileId,
      clearedWorkspaceIds,
      workspaceStartupUpdates,
    };
  });
}

function resolveRestartProfileId(
  stored: StoredWorkspace,
  launchProfiles: LaunchProfile[],
  launchProfileId: string | null | undefined
): string | null {
  if (launchProfileId === undefined) return stored.startupProfileId;
  if (launchProfileId === null) return null;
  const selectedProfileId = launchProfileId.trim();
  if (!selectedProfileId || !launchProfiles.some((profile) => profile.id === selectedProfileId)) {
    throw new WorkspaceMutationError('invalid-startup-profile', 'The launch profile was not found.');
  }
  return selectedProfileId;
}

async function sendLaunchProfile(
  tmuxSession: string,
  running: TmuxSession,
  launchProfiles: LaunchProfile[],
  launchProfileId: string | null
): Promise<void> {
  const profile = launchProfileId ? launchProfiles.find((candidate) => candidate.id === launchProfileId) : undefined;
  const mainTerminal = running.terminals[0];
  if (!profile || !mainTerminal) return;
  await sendTmuxInput(tmuxSession, `${profile.command}\n`);
}

export async function createManagedBackgroundProcess(id: string, command: string): Promise<TmuxTerminal> {
  return exclusively(async () => {
    const state = await readState();
    const stored = state.workspaces.find((workspace) => workspace.id === id);
    if (!stored) throw new WorkspaceMutationError('not-found', 'Workspace was not found.');

    const normalizedCommand = normalizeBackgroundCommand(command);
    const running = (await listTmuxSessions()).find((workspace) => workspace.name === stored.tmuxSession);
    if (!running)
      throw new WorkspaceMutationError(
        'workspace-not-running',
        'Reopen the workspace before running a background command.'
      );
    if (running.terminals.slice(1).length >= MAX_BACKGROUND_PROCESSES) {
      throw new WorkspaceMutationError(
        'background-limit',
        `A workspace can run up to ${MAX_BACKGROUND_PROCESSES} background commands.`
      );
    }
    return createTmuxBackgroundProcess(stored.tmuxSession, stored.cwd, normalizedCommand);
  });
}

export async function favoriteManagedBackgroundCommand(id: string, command: string): Promise<string[]> {
  return exclusively(async () => {
    const state = await readState();
    const index = state.workspaces.findIndex((workspace) => workspace.id === id);
    if (index < 0) throw new WorkspaceMutationError('not-found', 'Workspace was not found.');

    const normalizedCommand = normalizeBackgroundCommand(command);
    const stored = state.workspaces[index];
    if (stored.favoriteCommands.includes(normalizedCommand)) return stored.favoriteCommands;
    if (stored.favoriteCommands.length >= MAX_FAVORITE_COMMANDS) {
      throw new WorkspaceMutationError(
        'favorite-limit',
        `A workspace can save up to ${MAX_FAVORITE_COMMANDS} favorite commands.`
      );
    }

    const favoriteCommands = [...stored.favoriteCommands, normalizedCommand];
    const workspaces = [...state.workspaces];
    workspaces[index] = { ...stored, favoriteCommands };
    await writeState({ ...state, workspaces });
    return favoriteCommands;
  });
}

export async function removeManagedBackgroundCommandFavorite(id: string, command: string): Promise<string[]> {
  return exclusively(async () => {
    const state = await readState();
    const index = state.workspaces.findIndex((workspace) => workspace.id === id);
    if (index < 0) throw new WorkspaceMutationError('not-found', 'Workspace was not found.');

    const normalizedCommand = normalizeBackgroundCommand(command);
    const stored = state.workspaces[index];
    const favoriteCommands = stored.favoriteCommands.filter((favorite) => favorite !== normalizedCommand);
    if (favoriteCommands.length === stored.favoriteCommands.length) return stored.favoriteCommands;

    const workspaces = [...state.workspaces];
    workspaces[index] = { ...stored, favoriteCommands };
    await writeState({ ...state, workspaces });
    return favoriteCommands;
  });
}

export async function stopManagedBackgroundProcess(id: string, terminalId: string): Promise<void> {
  await exclusively(async () => {
    const state = await readState();
    const stored = state.workspaces.find((workspace) => workspace.id === id);
    if (!stored) throw new WorkspaceMutationError('not-found', 'Workspace was not found.');

    const running = (await listTmuxSessions()).find((workspace) => workspace.name === stored.tmuxSession);
    if (!running)
      throw new WorkspaceMutationError(
        'workspace-not-running',
        'Reopen the workspace before stopping a background process.'
      );
    const backgroundProcess = running.terminals.slice(1).find((candidate) => candidate.id === terminalId);
    if (!backgroundProcess) return;
    await killTmuxBackgroundProcess(stored.tmuxSession, backgroundProcess.id);
  });
}

export async function captureManagedBackgroundOutput(id: string, terminalId: string): Promise<string> {
  const state = await readState();
  const stored = state.workspaces.find((workspace) => workspace.id === id);
  if (!stored) throw new WorkspaceMutationError('not-found', 'Workspace was not found.');

  const running = (await listTmuxSessions()).find((workspace) => workspace.name === stored.tmuxSession);
  if (!running)
    throw new WorkspaceMutationError('workspace-not-running', 'Reopen the workspace before reading background output.');
  const backgroundProcess = running.terminals.slice(1).find((candidate) => candidate.id === terminalId);
  if (!backgroundProcess)
    throw new WorkspaceMutationError('background-not-found', 'Background process was not found in this workspace.');
  return captureTmuxBackgroundOutput(stored.tmuxSession, backgroundProcess.id);
}

export async function touchManagedWorkspace(id: string): Promise<number> {
  return exclusively(async () => {
    const state = await readState();
    const index = state.workspaces.findIndex((workspace) => workspace.id === id);
    if (index < 0) throw new WorkspaceMutationError('not-found', 'Workspace was not found.');

    const lastActiveAt = Date.now();
    const workspaces = [...state.workspaces];
    workspaces[index] = { ...workspaces[index], lastActiveAt };
    await writeState({ ...state, workspaces });
    return lastActiveAt;
  });
}

export async function updateManagedWorkspaceNote(id: string, note: string): Promise<string> {
  return exclusively(async () => {
    const state = await readState();
    const index = state.workspaces.findIndex((workspace) => workspace.id === id);
    if (index < 0) throw new WorkspaceMutationError('not-found', 'Workspace was not found.');

    const stored = state.workspaces[index];
    const normalizedNote = note.trim();
    await writeManagedWorkspaceNoteFile(stored.id, normalizedNote);
    return createWorkspaceNotePreview(normalizedNote);
  });
}

export async function updateManagedWorkspaceAlias(id: string, alias: string): Promise<string> {
  return exclusively(async () => {
    const workspaceLabel = normalizeWorkspaceAlias(alias);
    const state = await readState();
    const index = state.workspaces.findIndex((workspace) => workspace.id === id);
    if (index < 0) throw new WorkspaceMutationError('not-found', 'Workspace was not found.');

    const workspaces = [...state.workspaces];
    workspaces[index] = { ...workspaces[index], workspaceLabel };
    await writeState({ ...state, workspaces });
    return workspaceLabel;
  });
}

export async function findManagedWorkspaceNote(id: string): Promise<string | undefined> {
  const state = await readState();
  const stored = state.workspaces.find((workspace) => workspace.id === id);
  if (!stored) return undefined;
  return (await readManagedWorkspaceNoteFile(stored.id)) ?? '';
}

export async function closeManagedWorkspace(id: string): Promise<void> {
  await exclusively(async () => {
    const state = await readState();
    const stored = state.workspaces.find((workspace) => workspace.id === id);
    if (!stored) throw new WorkspaceMutationError('not-found', 'Workspace was not found.');

    await killTmuxSession(stored.tmuxSession);
  });
}

async function cleanupManagedWorktree(stored: StoredWorkspace): Promise<void> {
  if (stored.workspaceKind !== 'worktree' && !stored.worktreeBranch) return;
  try {
    await removeManagedGitWorktree({
      id: stored.id,
      cwd: stored.cwd,
      repositoryPath: stored.repositoryPath,
    });
  } catch (cause) {
    if (cause instanceof GitWorktreeError) {
      throw new WorkspaceMutationError('worktree-cleanup-failed', cause.message);
    }
    throw new WorkspaceMutationError(
      'worktree-cleanup-failed',
      'Vampire could not remove the managed working copy. The workspace remains registered.'
    );
  }
}

export async function removeManagedWorkspace(id: string): Promise<void> {
  await exclusively(async () => {
    const state = await readState();
    const stored = state.workspaces.find((workspace) => workspace.id === id);
    if (!stored) throw new WorkspaceMutationError('not-found', 'Workspace was not found.');

    const running = (await listTmuxSessions()).some((workspace) => workspace.name === stored.tmuxSession);
    if (running) {
      throw new WorkspaceMutationError('workspace-running', 'Close the workspace before removing this workspace.');
    }

    const removeNote = await prepareManagedWorkspaceNoteRemoval(stored.id);
    const removeAutomationRequests = await prepareWorkspaceAutomationRequestRemoval(stored.id);
    await cleanupManagedWorktree(stored);
    await writeState({ ...state, workspaces: state.workspaces.filter((workspace) => workspace.id !== id) });
    await Promise.all([removeNote(), removeAutomationRequests()]);
  });
}

export async function stopAndRemoveManagedWorkspace(id: string): Promise<void> {
  await exclusively(async () => {
    const state = await readState();
    const stored = state.workspaces.find((workspace) => workspace.id === id);
    if (!stored) throw new WorkspaceMutationError('not-found', 'Workspace was not found.');

    const removeNote = await prepareManagedWorkspaceNoteRemoval(stored.id);
    const removeAutomationRequests = await prepareWorkspaceAutomationRequestRemoval(stored.id);
    await killTmuxSession(stored.tmuxSession);
    await cleanupManagedWorktree(stored);
    await writeState({ ...state, workspaces: state.workspaces.filter((workspace) => workspace.id !== id) });
    await Promise.all([removeNote(), removeAutomationRequests()]);
  });
}
