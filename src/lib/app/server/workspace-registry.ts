import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import {
  createGitWorktree,
  GitWorktreeError,
  removeManagedGitWorktree,
  rollbackGitWorktree,
} from '~/lib/features/repository/server/git-worktree.ts';
import {
  isGitRepository as readIsGitRepository,
  readGitCheckoutIdentity,
  type GitCheckoutIdentity,
} from '~/lib/features/repository/server/repository.ts';
import {
  resolveAllowedWorkspaceDirectory,
  resolveExistingWorkspaceDirectory,
  WorkspaceRootError,
} from '~/lib/features/system/server/workspace-roots.ts';
import {
  captureTmuxBackgroundOutput,
  createTmuxBackgroundProcess,
  createTmuxSession,
  killTmuxBackgroundProcess,
  killTmuxSession,
  killTmuxTerminal,
  listTmuxSessions,
  sendTmuxInput,
  type TmuxProcessHint,
  type TmuxSession,
  type TmuxTerminal,
} from '~/lib/features/terminal/server/tmux.ts';
import { cancelActiveKingWorkflow } from '~/lib/features/workspace/server/king-workflow-store.ts';
import {
  KING_WORKSPACE_NAME,
  ensureManagedKingWorkspace,
  scheduleKingBootstrapAutomation,
} from '~/lib/features/workspace/server/king-workspace.ts';
import { createWorkspaceNotePreview } from '~/lib/features/workspace/server/workspace-note.ts';
import {
  ensureManagedWorkspaceNoteFile,
  readManagedWorkspaceNoteFile,
  writeManagedWorkspaceNoteFile,
} from '~/lib/features/workspace/server/workspace-note-file.ts';
import {
  BACKGROUND_COMMAND_MAX_LENGTH,
  effectiveWorkspaceKingControl,
  MAX_FAVORITE_COMMANDS,
  readWorkspaceStore as readState,
  storedWorkspaceCheckoutKey as workspaceCheckoutLeaseKey,
  type StoredWorkspace,
  storedWorkspacesShareCheckout,
  withWorkspaceStoreMutation,
  writeWorkspaceStore as writeState,
} from '~/lib/features/workspace/server/workspace-store.ts';
import { isLaunchProfileList, normalizeLaunchProfiles } from '~/lib/shared/contracts/launch-profiles.ts';
import type {
  LaunchProfile,
  WorkspaceHandoffSnapshot,
  WorkspaceKingControl,
  WorkspacePreferences,
} from '~/lib/shared/contracts/workspace.ts';
import type { AgentState } from '~/lib/shared/contracts/workspace-agent.ts';

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
  | 'invalid-workspace-preferences'
  | 'king-already-exists'
  | 'king-not-found'
  | 'king-control-conflict'
  | 'invalid-king-control'
  | 'king-controlled';

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

async function detectGitCheckoutIdentity(cwd: string): Promise<GitCheckoutIdentity | null> {
  try {
    return await readGitCheckoutIdentity(cwd);
  } catch {
    return null;
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

function normalizeKingControlReason(reason: string): string {
  const normalized = reason.trim();
  if (!normalized || normalized.length > 2_000 || /[\0]/.test(normalized)) {
    throw new WorkspaceMutationError(
      'invalid-king-control',
      'A King handoff reason between 1 and 2,000 characters is required.'
    );
  }
  return normalized;
}

function applyControlToCheckout(
  workspaces: StoredWorkspace[],
  target: StoredWorkspace,
  control: WorkspaceKingControl,
  now: number
): StoredWorkspace[] {
  return workspaces.map((candidate) => {
    if (candidate.workspaceKind === 'king' || !storedWorkspacesShareCheckout(candidate, target)) return candidate;
    if (candidate.id === target.id) return { ...candidate, kingControl: control };
    return { ...candidate, kingControl: { ...control, notifiedAt: now } };
  });
}

function inheritCheckoutControl(
  workspace: StoredWorkspace,
  existingWorkspaces: StoredWorkspace[],
  now: number
): StoredWorkspace {
  const control = effectiveWorkspaceKingControl(existingWorkspaces, workspace);
  if (control?.state !== 'king') return workspace;
  return { ...workspace, kingControl: { ...control, notifiedAt: now } };
}

function registrationMetadata(checkout: GitCheckoutIdentity | null): Partial<StoredWorkspace> {
  if (!checkout) return { workspaceKind: 'directory' };
  const repositoryMetadata = {
    repositoryPath: checkout.repositoryPath,
    checkoutKey: checkout.checkoutKey,
  };
  if (!checkout.linkedWorktree) return { workspaceKind: 'directory', ...repositoryMetadata };
  return {
    workspaceKind: 'worktree',
    ...repositoryMetadata,
    worktreeBranch: checkout.branch ?? undefined,
    managedWorktree: false,
  };
}

function grantedControlReason(workspace: StoredWorkspace, fallbackReason: string): string {
  if (workspace.kingControl?.state === 'requested') return workspace.kingControl.reason;
  return normalizeKingControlReason(fallbackReason);
}

function assertKingControlTarget(state: Awaited<ReturnType<typeof readState>>, index: number): StoredWorkspace {
  const workspace = state.workspaces[index];
  if (!workspace) throw new WorkspaceMutationError('not-found', 'Workspace was not found.');
  if (workspace.workspaceKind === 'king') {
    throw new WorkspaceMutationError('invalid-king-control', 'The King workspace cannot be handed over to itself.');
  }
  if (!state.workspaces.some((candidate) => candidate.workspaceKind === 'king')) {
    throw new WorkspaceMutationError('king-not-found', 'Create the King workspace before handing over a workspace.');
  }
  return workspace;
}

function assertCheckoutControlAvailable(
  state: Awaited<ReturnType<typeof readState>>,
  workspace: StoredWorkspace
): void {
  const leaseKey = workspaceCheckoutLeaseKey(workspace);
  const conflict = state.workspaces.find(
    (candidate) =>
      candidate.id !== workspace.id &&
      candidate.workspaceKind !== 'king' &&
      workspaceCheckoutLeaseKey(candidate) === leaseKey &&
      candidate.kingControl?.state === 'king'
  );
  if (conflict) {
    throw new WorkspaceMutationError(
      'king-control-conflict',
      `King already controls this checkout through workspace ${conflict.workspaceLabel || conflict.id}.`
    );
  }
}

function assertOwnerControlsWorkspace(state: Awaited<ReturnType<typeof readState>>, workspace: StoredWorkspace): void {
  if (effectiveWorkspaceKingControl(state.workspaces, workspace)?.state !== 'king') return;
  throw new WorkspaceMutationError(
    'king-controlled',
    'King controls this workspace. Take control from the crown menu before changing it manually.'
  );
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
      kingControl: effectiveWorkspaceKingControl(state.workspaces, workspace),
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

export async function updateManagedWorkspacePreferences(input: WorkspacePreferences): Promise<WorkspacePreferences> {
  return exclusively(async () => {
    const state = await readState();
    const workspacePreferences = reconcileWorkspacePreferences(state.workspaces, validateWorkspacePreferences(input));
    await writeState({ ...state, workspacePreferences });
    return workspacePreferences;
  });
}

export async function findWorkspaceDirectory(
  id: string
): Promise<Pick<StoredWorkspace, 'id' | 'cwd' | 'kingControl'> | undefined> {
  const state = await readState();
  const workspace = state.workspaces.find((candidate) => candidate.id === id);
  if (!workspace) return undefined;
  return {
    id: workspace.id,
    cwd: workspace.cwd,
    kingControl: effectiveWorkspaceKingControl(state.workspaces, workspace),
  };
}

export async function assertManagedWorkspaceOwnerControl(id: string): Promise<void> {
  const state = await readState();
  const workspace = state.workspaces.find((candidate) => candidate.id === id);
  if (!workspace) throw new WorkspaceMutationError('not-found', 'Workspace was not found.');
  assertOwnerControlsWorkspace(state, workspace);
}

export async function requestManagedWorkspaceKingControl(
  id: string,
  reason: string,
  now = Date.now()
): Promise<WorkspaceKingControl> {
  return exclusively(async () => {
    const state = await readState();
    const index = state.workspaces.findIndex((workspace) => workspace.id === id);
    const workspace = assertKingControlTarget(state, index);
    const effectiveControl = effectiveWorkspaceKingControl(state.workspaces, workspace);
    if (effectiveControl?.state === 'king') {
      const workspaces = applyControlToCheckout(state.workspaces, workspace, effectiveControl, now);
      await writeState({ ...state, workspaces });
      return effectiveControl;
    }
    const kingControl: WorkspaceKingControl = {
      state: 'requested',
      reason: normalizeKingControlReason(reason),
      requestedAt: now,
      changedAt: now,
      lastAction: 'requested',
      // King creates this request, so feeding it back to King would be a self-echo.
      notifiedAt: now,
      handoffSnapshot: workspace.kingControl?.handoffSnapshot ?? null,
    };
    const workspaces = [...state.workspaces];
    workspaces[index] = { ...workspace, kingControl };
    await writeState({ ...state, workspaces });
    return kingControl;
  });
}

export async function handOverManagedWorkspaceToKing(
  id: string,
  reason = 'The owner handed this workspace over to King.',
  handoffSnapshot: WorkspaceHandoffSnapshot | null = null,
  now = Date.now()
): Promise<WorkspaceKingControl> {
  return exclusively(async () => {
    const state = await readState();
    const index = state.workspaces.findIndex((workspace) => workspace.id === id);
    const workspace = assertKingControlTarget(state, index);
    const effectiveControl = effectiveWorkspaceKingControl(state.workspaces, workspace);
    if (effectiveControl?.state === 'king') {
      const workspaces = applyControlToCheckout(state.workspaces, workspace, effectiveControl, now);
      await writeState({ ...state, workspaces });
      return effectiveControl;
    }
    assertCheckoutControlAvailable(state, workspace);
    const kingControl: WorkspaceKingControl = {
      state: 'king',
      reason: grantedControlReason(workspace, reason),
      requestedAt: workspace.kingControl?.requestedAt ?? now,
      changedAt: now,
      lastAction: 'granted',
      notifiedAt: null,
      handoffSnapshot,
    };
    const workspaces = applyControlToCheckout(state.workspaces, workspace, kingControl, now);
    await writeState({ ...state, workspaces });
    return kingControl;
  });
}

export async function declineManagedWorkspaceKingControl(id: string, now = Date.now()): Promise<WorkspaceKingControl> {
  return exclusively(async () => {
    const state = await readState();
    const index = state.workspaces.findIndex((workspace) => workspace.id === id);
    const workspace = assertKingControlTarget(state, index);
    const kingControl: WorkspaceKingControl = {
      state: 'manual',
      reason: workspace.kingControl?.reason || 'The owner kept manual control.',
      requestedAt: null,
      changedAt: now,
      lastAction: 'declined',
      notifiedAt: null,
      handoffSnapshot: workspace.kingControl?.handoffSnapshot ?? null,
    };
    const workspaces = [...state.workspaces];
    workspaces[index] = { ...workspace, kingControl };
    await writeState({ ...state, workspaces });
    return kingControl;
  });
}

export async function releaseManagedWorkspaceKingControl(id: string, now = Date.now()): Promise<WorkspaceKingControl> {
  return exclusively(async () => {
    const state = await readState();
    const index = state.workspaces.findIndex((workspace) => workspace.id === id);
    const workspace = assertKingControlTarget(state, index);
    const kingControl: WorkspaceKingControl = {
      state: 'manual',
      reason: workspace.kingControl?.reason || 'The owner took control of this workspace.',
      requestedAt: null,
      changedAt: now,
      lastAction: 'released',
      notifiedAt: null,
      handoffSnapshot: workspace.kingControl?.handoffSnapshot ?? null,
    };
    const workspaces = applyControlToCheckout(state.workspaces, workspace, kingControl, now);
    await writeState({ ...state, workspaces });
    return kingControl;
  });
}

export async function markManagedWorkspaceKingControlNotified(
  id: string,
  changedAt: number,
  now = Date.now()
): Promise<void> {
  await exclusively(async () => {
    const state = await readState();
    const index = state.workspaces.findIndex((workspace) => workspace.id === id);
    const workspace = state.workspaces[index];
    if (!workspace?.kingControl || workspace.kingControl.changedAt !== changedAt) return;
    const workspaces = [...state.workspaces];
    workspaces[index] = {
      ...workspace,
      kingControl: { ...workspace.kingControl, notifiedAt: now },
    };
    await writeState({ ...state, workspaces });
  });
}

export async function createManagedWorkspace(input: { cwd: string }): Promise<ManagedWorkspace> {
  return exclusively(async () => {
    const cwd = await validateCwd(input.cwd);
    const checkout = await detectGitCheckoutIdentity(cwd);
    const gitRepository = checkout !== null;
    const id = randomUUID();
    const now = Date.now();
    const baseWorkspace: StoredWorkspace = {
      id,
      tmuxSession: `vampire-${id.slice(0, 8)}`,
      cwd,
      ...registrationMetadata(checkout),
      createdAt: now,
      lastActiveAt: now,
      automations: [],
      favoriteCommands: [],
      startupProfileId: null,
    };
    const current = await readState();
    const stored = inheritCheckoutControl(baseWorkspace, current.workspaces, now);
    await initializeManagedWorkspaceNote(stored);
    await writeState({ ...current, workspaces: [...current.workspaces, stored] });

    let tmux: TmuxSession;
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

    return {
      id: stored.id,
      tmuxSession: stored.tmuxSession,
      cwd: stored.cwd,
      workspaceKind: stored.workspaceKind,
      repositoryPath: stored.repositoryPath,
      workspaceLabel: stored.workspaceLabel,
      worktreeBranch: stored.worktreeBranch,
      managedWorktree: stored.managedWorktree,
      checkoutKey: stored.checkoutKey,
      kingControl: stored.kingControl,
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

export async function createManagedKingWorkspace(input: { launchProfileId: string | null }): Promise<ManagedWorkspace> {
  return exclusively(async () => {
    const current = await readState();
    if (current.workspaces.some((workspace) => workspace.workspaceKind === 'king')) {
      throw new WorkspaceMutationError('king-already-exists', 'This Vampire instance already has a King workspace.');
    }

    const launchProfileId = input.launchProfileId?.trim() ?? null;
    if (launchProfileId !== null && !current.launchProfiles.some((profile) => profile.id === launchProfileId)) {
      throw new WorkspaceMutationError('invalid-startup-profile', 'The launch profile was not found.');
    }

    const prepared = await ensureManagedKingWorkspace();
    const id = randomUUID();
    const now = Date.now();
    const stored: StoredWorkspace = {
      id,
      tmuxSession: `vampire-${id.slice(0, 8)}`,
      cwd: prepared.cwd,
      workspaceKind: 'king',
      workspaceLabel: KING_WORKSPACE_NAME,
      createdAt: now,
      lastActiveAt: now,
      automations: scheduleKingBootstrapAutomation([], prepared.bootstrapPrompt, now),
      favoriteCommands: [],
      startupProfileId: launchProfileId,
    };
    await initializeManagedWorkspaceNote(stored);
    await writeState({ ...current, workspaces: [...current.workspaces, stored] });

    let tmux: TmuxSession;
    try {
      tmux = await createTmuxSession(stored.tmuxSession, stored.cwd);
    } catch {
      const afterFailure = await readState();
      await writeState({
        ...afterFailure,
        workspaces: afterFailure.workspaces.filter((workspace) => workspace.id !== stored.id),
      });
      throw new WorkspaceLaunchError('tmux-launch-failed', 'tmux could not start the King workspace.');
    }

    if (launchProfileId) {
      try {
        await sendLaunchProfile(stored.tmuxSession, tmux, current.launchProfiles, launchProfileId);
      } catch {
        // Keep King's shell and pending bootstrap available when the optional agent command cannot start.
      }
    }

    return {
      id: stored.id,
      tmuxSession: stored.tmuxSession,
      cwd: stored.cwd,
      workspaceKind: stored.workspaceKind,
      workspaceLabel: stored.workspaceLabel,
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
      isGitRepository: false,
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
    const checkout = await detectGitCheckoutIdentity(worktree.cwd);
    const now = Date.now();
    const stored: StoredWorkspace = {
      id,
      tmuxSession: `vampire-${id.slice(0, 8)}`,
      cwd: worktree.cwd,
      workspaceKind: 'worktree',
      repositoryPath: source.repositoryPath ?? worktree.sourceRoot,
      workspaceLabel: worktree.label,
      worktreeBranch: worktree.branch,
      checkoutKey: checkout?.checkoutKey,
      managedWorktree: true,
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

    let tmux: TmuxSession;
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
      managedWorktree: stored.managedWorktree,
      checkoutKey: stored.checkoutKey,
      kingControl: stored.kingControl,
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
  input: { launchProfileId?: string | null; actor?: 'owner' | 'king' } = {}
): Promise<ManagedWorkspace> {
  return exclusively(async () => {
    const state = await readState();
    const index = state.workspaces.findIndex((workspace) => workspace.id === id);
    if (index < 0) throw new WorkspaceMutationError('not-found', 'Workspace was not found.');

    const stored = state.workspaces[index];
    if (input.actor !== 'king') assertOwnerControlsWorkspace(state, stored);
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
        managedWorktree: stored.managedWorktree,
        checkoutKey: stored.checkoutKey,
        kingControl: stored.kingControl,
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

    const preparedKing = stored.workspaceKind === 'king' ? await ensureManagedKingWorkspace() : undefined;
    const cwd = preparedKing?.cwd ?? (await validateExistingCwd(stored.cwd));
    const gitRepository = preparedKing ? false : await detectGitRepository(cwd);
    let restartedTmux: TmuxSession;
    try {
      restartedTmux = await createTmuxSession(stored.tmuxSession, cwd);
    } catch {
      throw new WorkspaceLaunchError('tmux-launch-failed', 'tmux could not restart the shell workspace.');
    }

    const restartedAt = Date.now();
    const restarted = {
      ...stored,
      cwd,
      createdAt: restartedAt,
      lastActiveAt: restartedAt,
      automations: preparedKing
        ? scheduleKingBootstrapAutomation(stored.automations, preparedKing.bootstrapPrompt, restartedAt)
        : stored.automations,
    };
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
      managedWorktree: restarted.managedWorktree,
      checkoutKey: restarted.checkoutKey,
      kingControl: restarted.kingControl,
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
  clearedWorkspaceIds: string[];
};

export type WorkspaceStartupUpdate = LaunchProfileUpdate & {
  startupProfileId: string | null;
};

export async function updateManagedLaunchProfiles(input: LaunchProfile[]): Promise<LaunchProfileUpdate> {
  return exclusively(async () => {
    const launchProfiles = validateLaunchProfiles(input);
    const state = await readState();
    const profileIds = new Set(launchProfiles.map((profile) => profile.id));
    const clearedWorkspaceIds: string[] = [];
    const workspaces = state.workspaces.map((workspace) => {
      if (!workspace.startupProfileId || profileIds.has(workspace.startupProfileId)) return workspace;
      clearedWorkspaceIds.push(workspace.id);
      return { ...workspace, startupProfileId: null };
    });
    await writeState({ ...state, launchProfiles, workspaces });
    return { launchProfiles, clearedWorkspaceIds };
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
    const workspaces = state.workspaces.map((workspace) => {
      if (workspace.id === id) return { ...workspace, startupProfileId };
      if (!workspace.startupProfileId || profileIds.has(workspace.startupProfileId)) return workspace;
      clearedWorkspaceIds.push(workspace.id);
      return { ...workspace, startupProfileId: null };
    });
    await writeState({ ...state, launchProfiles, workspaces });
    return { launchProfiles, startupProfileId, clearedWorkspaceIds };
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

export async function launchManagedWorkspaceProfile(id: string, launchProfileId: string): Promise<void> {
  return exclusively(async () => {
    const state = await readState();
    const stored = state.workspaces.find((workspace) => workspace.id === id);
    if (!stored) throw new WorkspaceMutationError('not-found', 'Workspace was not found.');
    assertOwnerControlsWorkspace(state, stored);
    const selectedProfileId = launchProfileId.trim();
    if (!selectedProfileId || !state.launchProfiles.some((profile) => profile.id === selectedProfileId)) {
      throw new WorkspaceMutationError('invalid-startup-profile', 'The launch profile was not found.');
    }
    const running = (await listTmuxSessions()).find((workspace) => workspace.name === stored.tmuxSession);
    if (!running) {
      throw new WorkspaceMutationError('workspace-not-running', 'Reopen the workspace before launching a profile.');
    }
    const mainTerminal = running.terminals[0];
    if (mainTerminal?.state !== 'running' || mainTerminal.foregroundProcess?.kind !== 'shell') {
      throw new WorkspaceMutationError(
        'workspace-running',
        'The main terminal must be an idle shell before Vampire can launch a profile.'
      );
    }
    await sendLaunchProfile(stored.tmuxSession, running, state.launchProfiles, selectedProfileId);
  });
}

export async function createManagedBackgroundProcess(id: string, command: string): Promise<TmuxTerminal> {
  return exclusively(async () => {
    const state = await readState();
    const stored = state.workspaces.find((workspace) => workspace.id === id);
    if (!stored) throw new WorkspaceMutationError('not-found', 'Workspace was not found.');
    assertOwnerControlsWorkspace(state, stored);

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
    if (stored.workspaceKind !== 'king') assertOwnerControlsWorkspace(state, stored);

    await killTmuxSession(stored.tmuxSession);
  });
}

async function cleanupManagedWorktree(stored: StoredWorkspace): Promise<void> {
  if (stored.workspaceKind !== 'worktree' && !stored.worktreeBranch) return;
  if (stored.managedWorktree === false) return;
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

function restoreOwnerControlAfterKingRemoval(workspace: StoredWorkspace, now: number): StoredWorkspace {
  const previous = workspace.kingControl;
  if (!previous || previous.state === 'manual') return workspace;
  return {
    ...workspace,
    kingControl: {
      state: 'manual',
      reason: 'The King workspace was removed, so Vampire returned control to the owner.',
      requestedAt: null,
      changedAt: now,
      lastAction: previous.state === 'king' ? 'released' : 'declined',
      notifiedAt: now,
      handoffSnapshot: previous.handoffSnapshot,
    },
  };
}

async function stopKingTaskTerminalsForRemoval(king: StoredWorkspace, sessions: TmuxSession[]): Promise<void> {
  const terminals = sessions.flatMap((session) => {
    if (session.name === king.tmuxSession) return [];
    return session.terminals
      .filter((terminal) => terminal.terminalKind === 'king-task')
      .map((terminal) => ({ session: session.name, terminalId: terminal.id }));
  });
  await Promise.all(terminals.map((terminal) => killTmuxTerminal(terminal.session, terminal.terminalId)));
}

async function workspacesAfterRemoval(
  state: Awaited<ReturnType<typeof readState>>,
  stored: StoredWorkspace,
  sessions: TmuxSession[],
  now: number
): Promise<StoredWorkspace[]> {
  await cleanupManagedWorktree(stored);
  const remaining = state.workspaces.filter((workspace) => workspace.id !== stored.id);
  if (stored.workspaceKind !== 'king') return remaining;
  await stopKingTaskTerminalsForRemoval(stored, sessions);
  await cancelActiveKingWorkflow('The owner removed the King workspace.', now);
  return remaining.map((workspace) => restoreOwnerControlAfterKingRemoval(workspace, now));
}

export async function removeManagedWorkspace(id: string): Promise<void> {
  await exclusively(async () => {
    const state = await readState();
    const stored = state.workspaces.find((workspace) => workspace.id === id);
    if (!stored) throw new WorkspaceMutationError('not-found', 'Workspace was not found.');

    if (stored.workspaceKind !== 'king') assertOwnerControlsWorkspace(state, stored);
    const sessions = await listTmuxSessions();
    const running = sessions.some((workspace) => workspace.name === stored.tmuxSession);
    if (running) {
      throw new WorkspaceMutationError('workspace-running', 'Close the workspace before removing this workspace.');
    }

    const workspaces = await workspacesAfterRemoval(state, stored, sessions, Date.now());
    await writeState({ ...state, workspaces });
  });
}

export async function stopAndRemoveManagedWorkspace(id: string): Promise<void> {
  await exclusively(async () => {
    const state = await readState();
    const stored = state.workspaces.find((workspace) => workspace.id === id);
    if (!stored) throw new WorkspaceMutationError('not-found', 'Workspace was not found.');
    if (stored.workspaceKind !== 'king') assertOwnerControlsWorkspace(state, stored);

    const sessions = await listTmuxSessions();
    await killTmuxSession(stored.tmuxSession);
    const workspaces = await workspacesAfterRemoval(state, stored, sessions, Date.now());
    await writeState({ ...state, workspaces });
  });
}
