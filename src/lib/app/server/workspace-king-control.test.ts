import assert from 'node:assert/strict';
import test from 'node:test';
import type { RepositoryFingerprint } from '~/lib/features/repository/server/repository-fingerprint.server.ts';
import type { TmuxSession } from '~/lib/features/terminal/server/tmux.server.ts';
import type { KingAttempt } from '~/lib/shared/contracts/king-workflow.ts';
import type { RepositorySnapshot } from '~/lib/shared/contracts/repository.ts';
import type { WorkspaceKingControl } from '~/lib/shared/contracts/workspace.ts';
import {
  handOverWorkspaceToKing,
  takeControlFromKing,
  type WorkspaceKingControlDependencies,
} from './workspace-king-control.server.ts';
import type { ManagedWorkspace } from './workspace-registry.server.ts';

function workspace(id = 'workspace-1'): ManagedWorkspace {
  return {
    id,
    tmuxSession: `session-${id}`,
    cwd: `/project/${id}`,
    workspaceKind: 'worktree',
    workspaceLabel: id,
    repositoryPath: '/project',
    worktreeBranch: `feature/${id}`,
    checkoutKey: 'checkout-1',
    createdAt: 1,
    lastActiveAt: 1,
    favoriteCommands: [],
    startupProfileId: 'codex',
    notePreview: '',
    state: 'running',
    lastOutputAt: 1,
    attachedClients: 0,
    foregroundProcess: { kind: 'command', label: 'codex' },
    terminals: [],
    agentState: 'waiting',
    isGitRepository: true,
    workspaceAvailable: true,
  };
}

function control(state: WorkspaceKingControl['state']): WorkspaceKingControl {
  return {
    state,
    reason: 'Owner handoff',
    requestedAt: state === 'manual' ? null : 1,
    changedAt: 1,
    lastAction: state === 'king' ? 'granted' : 'released',
    notifiedAt: 1,
    handoffSnapshot: null,
  };
}

function dependencies(overrides: Partial<WorkspaceKingControlDependencies> = {}): WorkspaceKingControlDependencies {
  const unavailable = async () => {
    throw new Error('Unexpected dependency call.');
  };
  return {
    findWorkspace: unavailable,
    listWorkspaces: unavailable,
    handOver: unavailable,
    decline: unavailable,
    release: unavailable,
    interruptAttempts: unavailable,
    listTmuxSessions: async () => [],
    interruptTerminal: unavailable,
    killTerminal: unavailable,
    readSnapshot: unavailable,
    readHeadRevision: unavailable,
    readCheckoutIdentity: unavailable,
    captureFingerprint: unavailable,
    ...overrides,
  } as WorkspaceKingControlDependencies;
}

test('captures an exact handoff snapshot before granting King the writer lease', async () => {
  const target = workspace();
  const repository: RepositorySnapshot = {
    isGitRepository: true,
    files: [],
    directories: [],
    ignored: [],
    changes: [{ path: 'src/existing.ts', status: ' M' }],
    changeStats: { additions: 2, deletions: 1 },
    truncated: false,
  };
  const fingerprint: RepositoryFingerprint = {
    repositoryStateHash: 'state-hash',
    changes: [{ ...repository.changes[0]!, diffHash: 'diff-hash' }],
  };
  let handoffArguments: Parameters<WorkspaceKingControlDependencies['handOver']> | undefined;

  const result = await handOverWorkspaceToKing(
    target.id,
    'Continue the existing worktree.',
    dependencies({
      findWorkspace: async () => target,
      readSnapshot: async () => repository,
      readHeadRevision: async () => 'a'.repeat(40),
      readCheckoutIdentity: async () => ({
        checkoutKey: 'checkout-1',
        root: target.cwd,
        repositoryPath: '/project',
        branch: 'feature/workspace-1',
        linkedWorktree: true,
      }),
      captureFingerprint: async () => fingerprint,
      handOver: async (...args) => {
        handoffArguments = args;
        return control('king');
      },
    }),
    100
  );

  assert.equal(result.control.state, 'king');
  assert.equal(handoffArguments?.[0], target.id);
  assert.equal(handoffArguments?.[1], 'Continue the existing worktree.');
  assert.deepEqual(handoffArguments?.[2], {
    capturedAt: 100,
    checkoutKey: 'checkout-1',
    isGitRepository: true,
    headRevision: 'a'.repeat(40),
    changes: repository.changes,
    changeFingerprints: fingerprint.changes,
    repositoryStateHash: fingerprint.repositoryStateHash,
  });
});

test('taking control interrupts every Attempt and task terminal sharing the checkout', async () => {
  const primary = { ...workspace('workspace-1'), kingControl: control('king') };
  const duplicate = workspace('workspace-2');
  const interruptedWorkspaceIds: string[] = [];
  const interruptedTerminals: string[] = [];
  const killed: string[] = [];
  const sessions: TmuxSession[] = [primary, duplicate].map((candidate, index) => ({
    name: candidate.tmuxSession,
    createdAt: 1,
    lastOutputAt: 1,
    attachedClients: 0,
    foregroundProcess: null,
    terminals: [
      {
        id: `@${index + 1}`,
        index: 1,
        name: 'king-task',
        active: false,
        lastOutputAt: 1,
        foregroundProcess: { kind: 'command', label: 'codex' },
        command: null,
        startedAt: 1,
        state: 'running',
        exitCode: null,
        terminalKind: 'king-task',
        kingAttemptId: `attempt-${index + 1}`,
      },
    ],
  }));

  const result = await takeControlFromKing(
    primary.id,
    dependencies({
      listWorkspaces: async () => [primary, duplicate],
      release: async () => control('manual'),
      interruptAttempts: async (workspaceId) => {
        interruptedWorkspaceIds.push(workspaceId);
        return [
          {
            id: `attempt-${workspaceId}`,
            deliveryTarget: {
              tmuxSession: `session-${workspaceId}`,
              terminalId: workspaceId === 'workspace-1' ? '@10' : '@20',
              agentLabel: 'codex',
            },
          } as KingAttempt,
        ];
      },
      listTmuxSessions: async () => sessions,
      interruptTerminal: async (session, terminalId) => {
        interruptedTerminals.push(`${session}:${terminalId}`);
      },
      killTerminal: async (session, terminalId) => {
        killed.push(`${session}:${terminalId}`);
      },
    }),
    200
  );

  assert.equal(result.control.state, 'manual');
  assert.deepEqual(interruptedWorkspaceIds.sort(), ['workspace-1', 'workspace-2']);
  assert.deepEqual(interruptedTerminals.sort(), ['session-workspace-1:@10', 'session-workspace-2:@20']);
  assert.deepEqual(killed.sort(), ['session-workspace-1:@1', 'session-workspace-2:@2']);
  assert.deepEqual(result.interruptedAttemptIds.sort(), ['attempt-workspace-1', 'attempt-workspace-2']);
});
