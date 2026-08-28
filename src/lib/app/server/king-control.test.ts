import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { KingAttempt, KingAttemptVerification, KingRun, KingTask } from '~/lib/shared/contracts/king-workflow.ts';
import type { RepositoryDiff, RepositorySnapshot } from '~/lib/shared/contracts/repository.ts';
import {
  handleKingControlRequest,
  type KingControlDependencies,
  runKingVerificationCommand,
} from './king-control.server.ts';
import type { ManagedWorkspace } from './workspace-registry.server.ts';

function workspace(): ManagedWorkspace {
  return {
    id: 'workspace-1',
    tmuxSession: 'vampire-workspace-1',
    cwd: '/project',
    workspaceKind: 'directory',
    workspaceLabel: 'Project',
    createdAt: 1,
    lastActiveAt: 1,
    favoriteCommands: [],
    startupProfileId: 'codex',
    notePreview: 'Important project',
    state: 'running',
    lastOutputAt: 1,
    attachedClients: 0,
    foregroundProcess: { kind: 'command', label: 'codex' },
    terminals: [],
    agentState: null,
    isGitRepository: true,
    workspaceAvailable: true,
  };
}

function snapshot(changes: RepositorySnapshot['changes'] = []): RepositorySnapshot {
  return {
    isGitRepository: true,
    files: [],
    directories: [],
    ignored: [],
    changes,
    changeStats: { additions: 0, deletions: 0 },
    truncated: false,
  };
}

function stateHash(changes: RepositorySnapshot['changes'], diffs: RepositoryDiff[]): string {
  const fingerprints = changes.map((change, index) => ({
    ...change,
    diffHash: diffHash(diffs[index]),
  }));
  return createHash('sha256').update(JSON.stringify(fingerprints)).digest('hex');
}

function diffHash(diff: RepositoryDiff | undefined): string {
  return createHash('sha256').update(JSON.stringify(diff)).digest('hex');
}

function dependencies(overrides: Partial<KingControlDependencies> = {}): KingControlDependencies {
  const unavailable = async () => {
    throw new Error('Unexpected dependency call.');
  };
  return {
    listWorkspaces: async () => [],
    findWorkspace: async () => undefined,
    findWorkspaceNote: async () => undefined,
    readAgentStates: async () => new Map(),
    readSnapshot: async () => snapshot(),
    readHeadRevision: async () => null,
    readDirectory: unavailable,
    readFile: unavailable,
    readDiff: unavailable,
    readCheckoutIdentity: async () => null,
    requestWorkspaceControl: unavailable,
    createRun: unavailable,
    createTask: unavailable,
    createAttempt: unavailable,
    listRuns: async () => [],
    readRun: unavailable,
    readTask: unavailable,
    readAttempt: unavailable,
    readSummary: async () => ({
      activeRuns: 0,
      activeTasks: 0,
      queuedAttempts: 0,
      needsOwner: 0,
      pendingDecisions: 0,
      pendingInbox: 0,
      recentInbox: [],
    }),
    listInbox: async () => [],
    acknowledgeInbox: async () => [],
    recordVerification: unavailable,
    decideAttempt: unavailable,
    createDecision: unavailable,
    listDecisions: async () => [],
    runVerification: unavailable,
    ...overrides,
  } as KingControlDependencies;
}

function task(): KingTask {
  return {
    id: 'task-1',
    runId: 'run-1',
    workspaceId: 'workspace-1',
    kind: 'change',
    title: 'Feature',
    objective: 'Implement feature',
    background: '',
    nonGoals: [],
    dependsOnTaskIds: [],
    acceptanceCriteria: ['Works'],
    allowedPaths: ['src'],
    forbiddenPaths: ['src/secrets'],
    verificationCommands: ['pnpm test'],
    approvalPolicy: 'auto',
    status: 'result-submitted',
    createdAt: 1,
    updatedAt: 1,
    completedAt: null,
  };
}

function attempt(): KingAttempt {
  return {
    id: 'attempt-1',
    runId: 'run-1',
    taskId: 'task-1',
    workspaceId: 'workspace-1',
    status: 'result-submitted',
    taskPacketPath: '/packet.json',
    baseline: { capturedAt: 1, isGitRepository: true, headRevision: null, changes: [], dirty: false },
    deliveryTarget: null,
    result: {
      schemaVersion: 1,
      attemptId: 'attempt-1',
      status: 'succeeded',
      summary: 'done',
      changedPaths: ['src/feature.ts'],
      verification: [{ command: 'pnpm test', outcome: 'passed' }],
      blockers: [],
      plan: null,
    },
    verification: null,
    verdict: null,
    startedEventHash: null,
    startedEventConflictHash: null,
    resultEventHash: 'hash',
    resultEventConflictHash: null,
    createdAt: 1,
    updatedAt: 1,
    deliveryAttemptedAt: 1,
    dispatchedAt: 1,
    startedAt: 1,
    resultSubmittedAt: 1,
  };
}

test('workspace inspection returns live state, complete note, and repository state through one control command', async () => {
  const target = workspace();
  const response = await handleKingControlRequest(
    { id: 'request-1', command: 'workspace.inspect', input: { workspaceId: target.id } },
    dependencies({
      findWorkspace: async () => target,
      findWorkspaceNote: async () => 'Full durable workspace note',
      readAgentStates: async () => new Map([[target.id, 'waiting']]),
      readSnapshot: async () => snapshot([{ path: 'src/dirty.ts', status: ' M' }]),
      readHeadRevision: async () => 'a'.repeat(40),
    })
  );
  assert.equal(response.ok, true);
  if (!response.ok) return;
  const data = response.data as {
    note: string;
    workspace: { agentState: string };
    repository: RepositorySnapshot;
    headRevision: string;
  };
  assert.equal(data.note, 'Full durable workspace note');
  assert.equal(data.workspace.agentState, 'waiting');
  assert.equal(data.repository.changes[0]?.path, 'src/dirty.ts');
  assert.equal(data.headRevision, 'a'.repeat(40));
});

test('workspace exploration is selective and refuses likely secret files', async () => {
  const target = workspace();
  const calls: string[] = [];
  const deps = dependencies({
    findWorkspace: async () => target,
    readDirectory: async (cwd, path) => {
      calls.push(`files:${cwd}:${path}`);
      return { files: ['src/app.ts'], directories: ['src/lib'], ignored: [], truncated: false };
    },
    readFile: async (cwd, path) => {
      calls.push(`read:${cwd}:${path}`);
      return { path, content: 'export const app = true;\n', size: 25, modifiedAt: 1, version: 'version' };
    },
  });
  const listed = await handleKingControlRequest(
    { id: 'request-files', command: 'workspace.files', input: { workspaceId: target.id, path: 'src' } },
    deps
  );
  assert.equal(listed.ok, true);
  const read = await handleKingControlRequest(
    { id: 'request-read', command: 'workspace.read', input: { workspaceId: target.id, path: 'src/app.ts' } },
    deps
  );
  assert.equal(read.ok, true);
  assert.deepEqual(calls, ['files:/project:src', 'read:/project:src/app.ts']);

  const secret = await handleKingControlRequest(
    { id: 'request-secret', command: 'workspace.read', input: { workspaceId: target.id, path: '.env.local' } },
    deps
  );
  assert.equal(secret.ok, false);
  if (!secret.ok) assert.match(secret.error, /secret files/i);
  assert.equal(calls.length, 2);
});

test('keeps run summaries compact and leaves command output behind attempt.show', async () => {
  const currentAttempt = attempt();
  currentAttempt.verification = {
    outcome: 'passed',
    checkedAt: 2,
    actualChanges: [{ path: 'src/feature.ts', status: ' M' }],
    attemptChangePaths: ['src/feature.ts'],
    unexpectedPaths: [],
    baselineDirty: false,
    baselineHeadRevision: null,
    currentHeadRevision: null,
    headRevisionChanged: false,
    commands: [
      {
        command: 'pnpm test',
        outcome: 'passed',
        exitCode: 0,
        stdout: 'verbose output that should stay scoped to attempt.show',
        stderr: '',
        durationMs: 10,
      },
    ],
    reasons: [],
  };
  const run: KingRun = {
    id: 'run-1',
    title: 'Compact run',
    objective: 'Keep context bounded.',
    ownerRequest: 'Keep context bounded.',
    workspaceIds: ['workspace-1'],
    planningPolicy: 'direct',
    phase: 'verifying',
    status: 'active',
    contractRevision: '3-test',
    createdAt: 1,
    updatedAt: 2,
    completedAt: null,
  };
  const response = await handleKingControlRequest(
    { id: 'request-run', command: 'run.show', input: { runId: run.id } },
    dependencies({
      readRun: async () => ({ run, tasks: [task()], attempts: [currentAttempt], decisions: [] }),
    })
  );
  assert.equal(response.ok, true);
  assert.doesNotMatch(JSON.stringify(response), /verbose output/);
  assert.match(JSON.stringify(response), /pnpm test/);
});

test('never accepts an owner identity claimed through the King control socket', async () => {
  let decidedBy: 'king' | 'owner' | undefined;
  const deps = dependencies({
    decideAttempt: async (_attemptId, decision) => {
      decidedBy = decision.decidedBy;
      return attempt();
    },
  });
  const spoofed = await handleKingControlRequest(
    {
      id: 'spoof-owner',
      command: 'attempt.decide',
      input: { attemptId: 'attempt-1', outcome: 'accepted', reason: 'Trust me.', decidedBy: 'owner' },
    },
    deps
  );
  assert.equal(spoofed.ok, false);
  if (!spoofed.ok) assert.match(spoofed.error, /authenticated Vampire UI/i);
  assert.equal(decidedBy, undefined);

  const kingDecision = await handleKingControlRequest(
    {
      id: 'king-decision',
      command: 'attempt.decide',
      input: { attemptId: 'attempt-1', outcome: 'accepted', reason: 'Verified.' },
    },
    deps
  );
  assert.equal(kingDecision.ok, true);
  assert.equal(decidedBy, 'king');
});

test('verification compares the real diff and reruns the declared command before recording a pass', async () => {
  let recorded: KingAttemptVerification | undefined;
  let verificationTimeoutMs: number | undefined;
  const currentAttempt = attempt();
  const response = await handleKingControlRequest(
    { id: 'request-2', command: 'attempt.verify', input: { attemptId: currentAttempt.id } },
    dependencies({
      readAttempt: async () => currentAttempt,
      readTask: async () => task(),
      findWorkspace: async () => workspace(),
      readSnapshot: async () => snapshot([{ path: 'src/feature.ts', status: ' M' }]),
      runVerification: async (cwd, command, timeoutMs) => {
        verificationTimeoutMs = timeoutMs;
        return {
          command,
          outcome: cwd === '/project' ? 'passed' : 'failed',
          exitCode: 0,
          stdout: 'ok',
          stderr: '',
          durationMs: 5,
        };
      },
      recordVerification: async (_id, verification) => {
        recorded = verification;
        return { ...currentAttempt, status: 'verified', verification };
      },
    })
  );
  assert.equal(response.ok, true);
  assert.equal(recorded?.outcome, 'passed');
  assert.deepEqual(recorded?.attemptChangePaths, ['src/feature.ts']);
  assert.deepEqual(recorded?.unexpectedPaths, []);
  assert.equal(recorded?.commands[0]?.outcome, 'passed');
  assert.equal(verificationTimeoutMs, 5 * 60_000);
});

test('verification fails on undeclared or forbidden changes and rejects mutating package commands', async () => {
  let recorded: KingAttemptVerification | undefined;
  const currentAttempt = attempt();
  const response = await handleKingControlRequest(
    { id: 'request-3', command: 'attempt.verify', input: { attemptId: currentAttempt.id } },
    dependencies({
      readAttempt: async () => currentAttempt,
      readTask: async () => task(),
      findWorkspace: async () => workspace(),
      readSnapshot: async () => snapshot([{ path: 'src/secrets/token.ts', status: '??' }]),
      runVerification: async (_cwd, command) => ({
        command,
        outcome: 'passed',
        exitCode: 0,
        stdout: '',
        stderr: '',
        durationMs: 1,
      }),
      recordVerification: async (_id, verification) => {
        recorded = verification;
        return { ...currentAttempt, status: 'failed', verification };
      },
    })
  );
  assert.equal(response.ok, true);
  assert.equal(recorded?.outcome, 'failed');
  assert.deepEqual(recorded?.unexpectedPaths, ['src/feature.ts', 'src/secrets/token.ts']);
  await assert.rejects(() => runKingVerificationCommand('/project', 'pnpm install'), /allowlisted verification/i);
  await assert.rejects(() => runKingVerificationCommand('/project', 'pnpm destroy'), /allowlisted verification/i);
});

test('shares one bounded timeout across every verification command', async () => {
  const timeouts: Array<number | undefined> = [];
  const currentAttempt = attempt();
  const response = await handleKingControlRequest(
    { id: 'bounded-verification', command: 'attempt.verify', input: { attemptId: currentAttempt.id } },
    dependencies({
      readAttempt: async () => currentAttempt,
      readTask: async () => ({ ...task(), verificationCommands: ['pnpm test', 'pnpm check'] }),
      findWorkspace: async () => workspace(),
      readSnapshot: async () => snapshot([{ path: 'src/feature.ts', status: ' M' }]),
      runVerification: async (_cwd, command, timeoutMs) => {
        timeouts.push(timeoutMs);
        return { command, outcome: 'passed', exitCode: 0, stdout: '', stderr: '', durationMs: 1 };
      },
      recordVerification: async (_id, verification) => ({
        ...currentAttempt,
        status: 'verified',
        verification,
      }),
    })
  );

  assert.equal(response.ok, true);
  assert.deepEqual(timeouts, [150_000, 150_000]);
});

test('verification fails when a worker changes Git HEAD even if its working tree diff looks correct', async () => {
  let recorded: KingAttemptVerification | undefined;
  const currentAttempt = attempt();
  currentAttempt.baseline.headRevision = 'a'.repeat(40);
  const response = await handleKingControlRequest(
    { id: 'request-4', command: 'attempt.verify', input: { attemptId: currentAttempt.id } },
    dependencies({
      readAttempt: async () => currentAttempt,
      readTask: async () => task(),
      findWorkspace: async () => workspace(),
      readSnapshot: async () => snapshot([{ path: 'src/feature.ts', status: ' M' }]),
      readHeadRevision: async () => 'b'.repeat(40),
      runVerification: async (_cwd, command) => ({
        command,
        outcome: 'passed',
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
        durationMs: 1,
      }),
      recordVerification: async (_id, verification) => {
        recorded = verification;
        return { ...currentAttempt, status: 'failed', verification };
      },
    })
  );
  assert.equal(response.ok, true);
  assert.equal(recorded?.outcome, 'failed');
  assert.equal(recorded?.headRevisionChanged, true);
  assert.match(recorded?.reasons.join(' ') ?? '', /HEAD changed/i);
});

test('captures a content fingerprint when dispatching into a dirty repository', async () => {
  const changes = [{ path: 'src/dirty.ts', status: ' M' }];
  const diff: RepositoryDiff = {
    path: 'src/dirty.ts',
    sections: [{ kind: 'working', patch: 'original dirty patch' }],
  };
  let baseline: KingAttempt['baseline'] | undefined;
  const response = await handleKingControlRequest(
    { id: 'analysis-dispatch', command: 'attempt.dispatch', input: { taskId: 'task-1' } },
    dependencies({
      readTask: async () => ({ ...task(), kind: 'analysis', verificationCommands: [] }),
      findWorkspace: async () => workspace(),
      readSnapshot: async () => snapshot(changes),
      readDiff: async () => diff,
      createAttempt: async (_taskId, nextBaseline) => {
        baseline = nextBaseline;
        return { ...attempt(), baseline: nextBaseline };
      },
    })
  );

  assert.equal(response.ok, true);
  assert.equal(baseline?.repositoryStateHash, stateHash(changes, [diff]));
});

test('never starts or assigns a stopped workspace through King control', async () => {
  const stoppedWorkspace: ManagedWorkspace = {
    ...workspace(),
    state: 'missing',
    foregroundProcess: null,
    terminals: [],
  };
  const stoppedDependencies = dependencies({
    findWorkspace: async () => stoppedWorkspace,
    readTask: async () => task(),
  });
  const requests = [
    {
      id: 'shortlist-stopped',
      command: 'run.create' as const,
      input: {
        title: 'Use live workspaces',
        objective: 'Do not start stopped workspaces.',
        workspaceIds: [stoppedWorkspace.id],
      },
    },
    {
      id: 'task-stopped',
      command: 'task.create' as const,
      input: {
        runId: 'run-1',
        workspaceId: stoppedWorkspace.id,
        title: 'Do work',
        objective: 'Remain stopped.',
        acceptanceCriteria: ['No workspace was started.'],
      },
    },
    {
      id: 'dispatch-stopped',
      command: 'attempt.dispatch' as const,
      input: { taskId: 'task-1' },
    },
  ];

  for (const request of requests) {
    const response = await handleKingControlRequest(request, stoppedDependencies);
    assert.equal(response.ok, false);
    if (!response.ok) assert.match(response.error, /stopped.*open it manually/i);
  }
});

test('refuses to assign a running workspace that has only a shell', async () => {
  const shellWorkspace: ManagedWorkspace = {
    ...workspace(),
    foregroundProcess: { kind: 'shell', label: 'zsh' },
    terminals: [],
  };
  const response = await handleKingControlRequest(
    {
      id: 'shell-task',
      command: 'task.create',
      input: {
        runId: 'run-1',
        workspaceId: shellWorkspace.id,
        title: 'Do not invent an agent',
        objective: 'Use only an existing agent.',
        acceptanceCriteria: ['No agent was launched.'],
      },
    },
    dependencies({ findWorkspace: async () => shellWorkspace })
  );

  assert.equal(response.ok, false);
  if (!response.ok) assert.match(response.error, /no recognized main agent.*start Codex or Claude manually/i);
});

test('requires King control for write Tasks and leases the exact Git checkout after handoff', async () => {
  const rejected = await handleKingControlRequest(
    { id: 'change-without-control', command: 'attempt.dispatch', input: { taskId: 'task-1' } },
    dependencies({
      readTask: async () => task(),
      findWorkspace: async () => workspace(),
    })
  );
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.match(rejected.error, /manual control/i);

  let requestedReason = '';
  const requested = await handleKingControlRequest(
    {
      id: 'request-control',
      command: 'workspace.control.request',
      input: { workspaceId: 'workspace-1', reason: 'Implement the approved feature.' },
    },
    dependencies({
      findWorkspace: async () => workspace(),
      requestWorkspaceControl: async (_workspaceId, reason) => {
        requestedReason = reason;
        return {
          state: 'requested',
          reason,
          requestedAt: 1,
          changedAt: 1,
          lastAction: 'requested',
          notifiedAt: 1,
          handoffSnapshot: null,
        };
      },
    })
  );
  assert.equal(requested.ok, true);
  assert.equal(requestedReason, 'Implement the approved feature.');

  let baseline: KingAttempt['baseline'] | undefined;
  const grantedWorkspace: ManagedWorkspace = {
    ...workspace(),
    checkoutKey: 'stored-checkout-key',
    kingControl: {
      state: 'king',
      reason: 'Approved',
      requestedAt: 1,
      changedAt: 2,
      lastAction: 'granted',
      notifiedAt: 2,
      handoffSnapshot: null,
    },
  };
  const dispatched = await handleKingControlRequest(
    { id: 'change-with-control', command: 'attempt.dispatch', input: { taskId: 'task-1' } },
    dependencies({
      readTask: async () => task(),
      findWorkspace: async () => grantedWorkspace,
      readSnapshot: async () => snapshot(),
      readCheckoutIdentity: async () => ({
        checkoutKey: 'live-checkout-key',
        root: '/project',
        repositoryPath: '/project',
        branch: 'feature',
        linkedWorktree: true,
      }),
      createAttempt: async (_taskId, nextBaseline) => {
        baseline = nextBaseline;
        return { ...attempt(), baseline: nextBaseline };
      },
    })
  );
  assert.equal(dispatched.ok, true);
  assert.equal(baseline?.workspaceLeaseKey, 'live-checkout-key');
});

test('attributes edits to a file that was already dirty at handoff', async () => {
  const changes = [{ path: 'src/existing.ts', status: ' M' }];
  const originalDiff: RepositoryDiff = {
    path: 'src/existing.ts',
    sections: [{ kind: 'working', patch: 'owner work' }],
  };
  const workerDiff: RepositoryDiff = {
    path: 'src/existing.ts',
    sections: [{ kind: 'working', patch: 'owner work plus worker change' }],
  };
  const dirtyAttempt: KingAttempt = {
    ...attempt(),
    baseline: {
      capturedAt: 1,
      isGitRepository: true,
      headRevision: null,
      changes,
      dirty: true,
      repositoryStateHash: stateHash(changes, [originalDiff]),
      changeFingerprints: [{ ...changes[0]!, diffHash: diffHash(originalDiff) }],
    },
    result: {
      ...attempt().result!,
      changedPaths: ['src/existing.ts'],
    },
  };
  let verification: KingAttemptVerification | undefined;

  const response = await handleKingControlRequest(
    { id: 'verify-existing-dirty-file', command: 'attempt.verify', input: { attemptId: dirtyAttempt.id } },
    dependencies({
      readAttempt: async () => dirtyAttempt,
      readTask: async () => task(),
      findWorkspace: async () => workspace(),
      readSnapshot: async () => snapshot(changes),
      readDiff: async () => workerDiff,
      runVerification: async (_cwd, command) => ({
        command,
        outcome: 'passed',
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
        durationMs: 1,
      }),
      recordVerification: async (_id, nextVerification) => {
        verification = nextVerification;
        return { ...dirtyAttempt, status: 'verified', verification: nextVerification };
      },
    })
  );

  assert.equal(response.ok, true);
  assert.equal(verification?.outcome, 'passed');
  assert.deepEqual(verification?.attemptChangePaths, ['src/existing.ts']);
  assert.deepEqual(verification?.reasons, []);
});

test('verifies a clean analysis without project commands and rejects any analysis-side file change', async () => {
  const analysisTask: KingTask = {
    ...task(),
    kind: 'analysis',
    title: 'Analyze candidate',
    verificationCommands: [],
    allowedPaths: [],
  };
  const analysisAttempt: KingAttempt = {
    ...attempt(),
    result: {
      schemaVersion: 1,
      attemptId: 'attempt-1',
      status: 'succeeded',
      summary: 'Candidate analysis complete.',
      changedPaths: [],
      verification: [],
      blockers: [],
      plan: {
        candidateWorkspaceId: 'workspace-1',
        recommendation: 'proceed',
        confidence: 0.9,
        summary: 'Implement the bounded change.',
        steps: ['Change the feature'],
        assumptions: [],
        risks: [],
        questions: [],
        proposedTasks: [
          {
            workspaceId: 'workspace-1',
            title: 'Implement feature',
            objective: 'Implement it.',
            acceptanceCriteria: ['Works'],
            allowedPaths: ['src'],
            forbiddenPaths: [],
            verificationCommands: ['pnpm test'],
            approvalPolicy: 'auto',
          },
        ],
      },
    },
  };
  let cleanVerification: KingAttemptVerification | undefined;
  const clean = await handleKingControlRequest(
    { id: 'analysis-clean', command: 'attempt.verify', input: { attemptId: analysisAttempt.id } },
    dependencies({
      readAttempt: async () => analysisAttempt,
      readTask: async () => analysisTask,
      findWorkspace: async () => workspace(),
      readSnapshot: async () => snapshot(),
      recordVerification: async (_id, verification) => {
        cleanVerification = verification;
        return { ...analysisAttempt, status: 'verified', verification };
      },
    })
  );
  assert.equal(clean.ok, true);
  assert.equal(cleanVerification?.outcome, 'passed');
  assert.deepEqual(cleanVerification?.commands, []);

  const dirtyChanges = [{ path: 'src/dirty.ts', status: ' M' }];
  const originalDiff: RepositoryDiff = {
    path: 'src/dirty.ts',
    sections: [{ kind: 'working', patch: 'original dirty patch' }],
  };
  const dirtyAnalysisAttempt: KingAttempt = {
    ...analysisAttempt,
    baseline: {
      ...analysisAttempt.baseline,
      changes: dirtyChanges,
      dirty: true,
      repositoryStateHash: stateHash(dirtyChanges, [originalDiff]),
    },
  };
  let dirtyVerification: KingAttemptVerification | undefined;
  await handleKingControlRequest(
    { id: 'analysis-dirty-unchanged', command: 'attempt.verify', input: { attemptId: dirtyAnalysisAttempt.id } },
    dependencies({
      readAttempt: async () => dirtyAnalysisAttempt,
      readTask: async () => analysisTask,
      findWorkspace: async () => workspace(),
      readSnapshot: async () => snapshot(dirtyChanges),
      readDiff: async () => originalDiff,
      recordVerification: async (_id, verification) => {
        dirtyVerification = verification;
        return { ...dirtyAnalysisAttempt, status: 'verified', verification };
      },
    })
  );
  assert.equal(dirtyVerification?.outcome, 'passed');
  assert.deepEqual(dirtyVerification?.reasons, []);

  let fingerprintFailure: KingAttemptVerification | undefined;
  await handleKingControlRequest(
    { id: 'analysis-dirty-mutated', command: 'attempt.verify', input: { attemptId: dirtyAnalysisAttempt.id } },
    dependencies({
      readAttempt: async () => dirtyAnalysisAttempt,
      readTask: async () => analysisTask,
      findWorkspace: async () => workspace(),
      readSnapshot: async () => snapshot(dirtyChanges),
      readDiff: async () => ({
        ...originalDiff,
        sections: [{ kind: 'working', patch: 'worker changed the dirty file' }],
      }),
      recordVerification: async (_id, verification) => {
        fingerprintFailure = verification;
        return { ...dirtyAnalysisAttempt, status: 'failed', verification };
      },
    })
  );
  assert.equal(fingerprintFailure?.outcome, 'failed');
  assert.match(fingerprintFailure?.reasons.join(' ') ?? '', /diff content changed/i);

  let changedVerification: KingAttemptVerification | undefined;
  await handleKingControlRequest(
    { id: 'analysis-mutated', command: 'attempt.verify', input: { attemptId: analysisAttempt.id } },
    dependencies({
      readAttempt: async () => analysisAttempt,
      readTask: async () => analysisTask,
      findWorkspace: async () => workspace(),
      readSnapshot: async () => snapshot([{ path: 'src/touched.ts', status: '??' }]),
      recordVerification: async (_id, verification) => {
        changedVerification = verification;
        return { ...analysisAttempt, status: 'failed', verification };
      },
    })
  );
  assert.equal(changedVerification?.outcome, 'failed');
  assert.match(changedVerification?.reasons.join(' ') ?? '', /declared changedPaths/i);
});
