import { captureRepositoryFingerprint } from '~/lib/features/repository/server/repository-fingerprint.server.ts';
import {
  readGitCheckoutIdentity,
  readRepositoryHeadRevision,
  readRepositorySnapshot,
} from '~/lib/features/repository/server/repository.server.ts';
import {
  interruptTmuxTerminal,
  killTmuxTerminal,
  listTmuxSessions,
} from '~/lib/features/terminal/server/tmux.server.ts';
import { interruptKingWorkspaceAttempts } from '~/lib/features/workspace/server/king-workflow-store.server.ts';
import type { WorkspaceHandoffSnapshot, WorkspaceKingControl } from '~/lib/shared/contracts/workspace.ts';
import { workspaceHasRecognizedMainAgent } from '~/lib/shared/contracts/workspace-agent.ts';
import {
  declineManagedWorkspaceKingControl,
  findManagedWorkspace,
  handOverManagedWorkspaceToKing,
  listManagedWorkspaces,
  releaseManagedWorkspaceKingControl,
  type ManagedWorkspace,
  WorkspaceMutationError,
} from './workspace-registry.server.ts';

export type WorkspaceKingControlDependencies = {
  findWorkspace: typeof findManagedWorkspace;
  listWorkspaces: typeof listManagedWorkspaces;
  handOver: typeof handOverManagedWorkspaceToKing;
  decline: typeof declineManagedWorkspaceKingControl;
  release: typeof releaseManagedWorkspaceKingControl;
  interruptAttempts: typeof interruptKingWorkspaceAttempts;
  listTmuxSessions: typeof listTmuxSessions;
  interruptTerminal: typeof interruptTmuxTerminal;
  killTerminal: typeof killTmuxTerminal;
  readSnapshot: typeof readRepositorySnapshot;
  readHeadRevision: typeof readRepositoryHeadRevision;
  readCheckoutIdentity: typeof readGitCheckoutIdentity;
  captureFingerprint: typeof captureRepositoryFingerprint;
};

const defaultDependencies: WorkspaceKingControlDependencies = {
  findWorkspace: findManagedWorkspace,
  listWorkspaces: listManagedWorkspaces,
  handOver: handOverManagedWorkspaceToKing,
  decline: declineManagedWorkspaceKingControl,
  release: releaseManagedWorkspaceKingControl,
  interruptAttempts: interruptKingWorkspaceAttempts,
  listTmuxSessions,
  interruptTerminal: interruptTmuxTerminal,
  killTerminal: killTmuxTerminal,
  readSnapshot: readRepositorySnapshot,
  readHeadRevision: readRepositoryHeadRevision,
  readCheckoutIdentity: readGitCheckoutIdentity,
  captureFingerprint: captureRepositoryFingerprint,
};

function requireControlTarget(workspace: ManagedWorkspace | undefined, workspaceId: string): ManagedWorkspace {
  if (!workspace) throw new Error(`Workspace ${workspaceId} was not found.`);
  if (workspace.workspaceKind === 'king') throw new Error('The King workspace cannot control itself.');
  return workspace;
}

function requireAvailableControlTarget(workspace: ManagedWorkspace | undefined, workspaceId: string): ManagedWorkspace {
  const target = requireControlTarget(workspace, workspaceId);
  if (!target.workspaceAvailable) throw new Error(`Workspace ${workspaceId} is unavailable.`);
  return target;
}

function requireLiveAgentControlTarget(workspace: ManagedWorkspace | undefined, workspaceId: string): ManagedWorkspace {
  const target = requireAvailableControlTarget(workspace, workspaceId);
  if (target.state !== 'running') {
    throw new WorkspaceMutationError(
      'workspace-not-running',
      `Workspace ${workspaceId} is stopped. Open it and start its agent before handing it to King.`
    );
  }
  if (!workspaceHasRecognizedMainAgent(target)) {
    throw new WorkspaceMutationError(
      'invalid-king-control',
      `Workspace ${workspaceId} has no recognized main agent. Start Codex or Claude before handing it to King.`
    );
  }
  return target;
}

async function captureHandoffSnapshot(
  workspace: ManagedWorkspace,
  dependencies: WorkspaceKingControlDependencies,
  now: number
): Promise<WorkspaceHandoffSnapshot> {
  const [repository, headRevision, checkout] = await Promise.all([
    dependencies.readSnapshot(workspace.cwd),
    dependencies.readHeadRevision(workspace.cwd),
    dependencies.readCheckoutIdentity(workspace.cwd),
  ]);
  const fingerprint = await dependencies.captureFingerprint(workspace.cwd, repository);
  return {
    capturedAt: now,
    checkoutKey: checkout?.checkoutKey ?? workspace.checkoutKey ?? null,
    isGitRepository: repository.isGitRepository,
    headRevision,
    changes: repository.changes,
    changeFingerprints: fingerprint?.changes ?? null,
    repositoryStateHash: fingerprint?.repositoryStateHash ?? null,
  };
}

function checkoutLeaseKey(workspace: ManagedWorkspace): string {
  return workspace.checkoutKey || workspace.cwd;
}

function workspacesSharingCheckout(target: ManagedWorkspace, workspaces: ManagedWorkspace[]): ManagedWorkspace[] {
  const leaseKey = checkoutLeaseKey(target);
  return workspaces.filter(
    (workspace) => workspace.workspaceKind !== 'king' && checkoutLeaseKey(workspace) === leaseKey
  );
}

async function stopKingTaskTerminals(
  workspaces: ManagedWorkspace[],
  dependencies: WorkspaceKingControlDependencies
): Promise<void> {
  const sessions = await dependencies.listTmuxSessions();
  const sessionByName = new Map(sessions.map((session) => [session.name, session]));
  const stops: Promise<void>[] = [];
  for (const workspace of workspaces) {
    const session = sessionByName.get(workspace.tmuxSession);
    if (!session) continue;
    for (const terminal of session.terminals) {
      if (terminal.terminalKind !== 'king-task') continue;
      stops.push(dependencies.killTerminal(workspace.tmuxSession, terminal.id).catch(() => undefined));
    }
  }
  await Promise.all(stops);
}

export type WorkspaceControlActionResult = {
  control: WorkspaceKingControl;
  interruptedAttemptIds: string[];
};

export async function handOverWorkspaceToKing(
  workspaceId: string,
  reason?: string,
  dependencies: WorkspaceKingControlDependencies = defaultDependencies,
  now = Date.now()
): Promise<WorkspaceControlActionResult> {
  const workspace = requireLiveAgentControlTarget(await dependencies.findWorkspace(workspaceId), workspaceId);
  const snapshot = await captureHandoffSnapshot(workspace, dependencies, now);
  const control = await dependencies.handOver(
    workspaceId,
    reason || 'The owner handed this workspace over to King.',
    snapshot,
    now
  );
  return { control, interruptedAttemptIds: [] };
}

export async function declineWorkspaceKingControl(
  workspaceId: string,
  dependencies: WorkspaceKingControlDependencies = defaultDependencies,
  now = Date.now()
): Promise<WorkspaceControlActionResult> {
  const control = await dependencies.decline(workspaceId, now);
  return { control, interruptedAttemptIds: [] };
}

export async function takeControlFromKing(
  workspaceId: string,
  dependencies: WorkspaceKingControlDependencies = defaultDependencies,
  now = Date.now()
): Promise<WorkspaceControlActionResult> {
  const workspaces = await dependencies.listWorkspaces();
  const target = requireControlTarget(
    workspaces.find((workspace) => workspace.id === workspaceId),
    workspaceId
  );
  const checkoutWorkspaces = workspacesSharingCheckout(target, workspaces);
  const control = await dependencies.release(workspaceId, now);
  const interrupted = (
    await Promise.all(
      checkoutWorkspaces.map((workspace) =>
        dependencies.interruptAttempts(
          workspace.id,
          `The owner took control of checkout ${checkoutLeaseKey(target)}.`,
          now
        )
      )
    )
  ).flat();
  await Promise.all(
    interrupted.flatMap((attempt) => {
      const target = attempt.deliveryTarget;
      return target
        ? [dependencies.interruptTerminal(target.tmuxSession, target.terminalId).catch(() => undefined)]
        : [];
    })
  );
  await stopKingTaskTerminals(checkoutWorkspaces, dependencies);
  return {
    control,
    interruptedAttemptIds: [...new Set(interrupted.map((attempt) => attempt.id))],
  };
}
