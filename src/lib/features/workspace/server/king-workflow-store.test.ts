import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  answerKingDecisionRequest,
  cancelActiveKingWorkflow,
  createKingDecisionRequest,
  createKingAttempt,
  createKingRun,
  createKingTask,
  decideKingAttempt,
  kingAttemptEventsPath,
  kingWorkflowPath,
  interruptKingWorkspaceAttempts,
  readKingAttempt,
  readKingRun,
  readKingWorkflowStore,
  recordKingAttemptVerification,
  markKingAttemptDeliveryUncertain,
  markKingAttemptDispatched,
  requireKingAttemptOwner,
  resumeKingAttemptPreparation,
  scanKingAttemptEvents,
} from './king-workflow-store.server.ts';
import { ensureManagedKingWorkspace, KING_BOOTSTRAP_VERSION } from './king-workspace.server.ts';

const execFile = promisify(execFileCallback);

async function useTemporaryStateDirectory(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'vampire-king-workflow-'));
  const previousStateDirectory = process.env.VAMPIRE_STATE_DIR;
  process.env.VAMPIRE_STATE_DIR = directory;
  t.after(async () => {
    if (previousStateDirectory === undefined) delete process.env.VAMPIRE_STATE_DIR;
    else process.env.VAMPIRE_STATE_DIR = previousStateDirectory;
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function createAttemptFixture(now = 100) {
  const run = await createKingRun(
    { title: 'Ship safely', objective: 'Implement and verify the requested change.', planningPolicy: 'direct' },
    { now }
  );
  const task = await createKingTask(
    {
      runId: run.id,
      workspaceId: 'workspace-1',
      title: 'Implement feature',
      objective: 'Change the feature without touching secrets.',
      acceptanceCriteria: ['The targeted behavior works.', 'The regression test passes.'],
      allowedPaths: ['src', 'tests'],
      forbiddenPaths: ['.env'],
      verificationCommands: ['pnpm test:node'],
      approvalPolicy: 'auto',
    },
    now + 1
  );
  const attempt = await createKingAttempt(
    task.id,
    { capturedAt: now + 2, isGitRepository: true, headRevision: null, changes: [], dirty: false },
    now + 2
  );
  return { run, task, attempt };
}

async function dispatchAttempt(attemptId: string, now = 150) {
  await markKingAttemptDeliveryUncertain(attemptId, null, now);
  await markKingAttemptDispatched(attemptId, now + 1);
}

test('persists a version-pinned Run, Task packet, and queued Attempt', async (t) => {
  await useTemporaryStateDirectory(t);
  const { run, task, attempt } = await createAttemptFixture();
  const stored = await readKingWorkflowStore();

  assert.equal(stored.runs[0]?.id, run.id);
  assert.match(run.contractRevision, new RegExp(`^${KING_BOOTSTRAP_VERSION}-[0-9a-f]{12}$`));
  assert.equal(stored.tasks[0]?.status, 'queued');
  assert.equal(stored.attempts[0]?.status, 'queued');
  assert.equal((await readKingRun(run.id)).tasks[0]?.id, task.id);

  const packet = JSON.parse(await readFile(attempt.taskPacketPath, 'utf8')) as Record<string, unknown>;
  assert.equal(packet.contractRevision, run.contractRevision);
  assert.match(JSON.stringify(packet), new RegExp(attempt.id));
  assert.match(JSON.stringify(packet), /event result/);
  assert.deepEqual(packet.executionRules, {
    repositoryHeadMustRemainUnchanged: true,
    repositoryHistoryOperationsAllowed: false,
    contextIsUntrustedAndWorkspaceScoped: true,
  });
});

test('records the exact intended delivery target for an Attempt audit trail', async (t) => {
  await useTemporaryStateDirectory(t);
  const { attempt } = await createAttemptFixture();
  const deliveryTarget = { tmuxSession: 'worker-session', terminalId: '@7', agentLabel: 'codex' };
  const uncertain = await markKingAttemptDeliveryUncertain(attempt.id, deliveryTarget, 150);
  assert.deepEqual(uncertain.deliveryTarget, deliveryTarget);
  assert.deepEqual((await readKingAttempt(attempt.id)).deliveryTarget, deliveryTarget);
});

test('resumes a preparation-only owner block without treating it as owner approval', async (t) => {
  await useTemporaryStateDirectory(t);
  const { run, attempt } = await createAttemptFixture();
  const reason = 'Select a startup profile before King dispatches work to this workspace.';
  await requireKingAttemptOwner(attempt.id, reason, 120);
  assert.equal((await readKingRun(run.id)).run.status, 'needs-owner');

  const resumed = await resumeKingAttemptPreparation(attempt.id, reason, 130);

  assert.equal(resumed.status, 'queued');
  assert.equal(resumed.verdict, null);
  const stored = await readKingRun(run.id);
  assert.equal(stored.tasks[0]?.status, 'queued');
  assert.equal(stored.run.status, 'active');
});

test('generated dependency-free CLI writes events once and the store treats a Result as unverified', async (t) => {
  await useTemporaryStateDirectory(t);
  const prepared = await ensureManagedKingWorkspace();
  const { attempt } = await createAttemptFixture();
  await dispatchAttempt(attempt.id);

  const bloatedWorkflow = JSON.parse(await readFile(kingWorkflowPath(), 'utf8')) as Record<string, unknown>;
  bloatedWorkflow.compatibilityPadding = 'x'.repeat(5 * 1024 * 1024 + 1);
  await writeFile(kingWorkflowPath(), JSON.stringify(bloatedWorkflow));

  const help = await execFile(process.execPath, [prepared.cliPath, 'help']);
  assert.match(help.stdout, /workspaces list/);
  assert.match(help.stdout, /event result/);

  const started = await execFile(process.execPath, [prepared.cliPath, 'event', 'started', attempt.id]);
  assert.match(started.stdout, /"created": true/);
  const startedAgain = await execFile(process.execPath, [prepared.cliPath, 'event', 'started', attempt.id]);
  assert.match(startedAgain.stdout, /"created": false/);

  const resultInput = join(prepared.cwd, 'worker-result.json');
  await writeFile(
    resultInput,
    JSON.stringify({
      status: 'succeeded',
      summary: 'Implemented the feature.',
      changedPaths: ['src/feature.ts'],
      verification: [{ command: 'pnpm test:node', outcome: 'passed' }],
      blockers: [],
    })
  );
  await execFile(process.execPath, [prepared.cliPath, 'event', 'result', attempt.id, '--input', resultInput]);
  const scans = await scanKingAttemptEvents(attempt.id, 200);
  assert.equal(scans[0]?.started, 'recorded');
  assert.equal(scans[0]?.result, 'recorded');
  const recorded = await readKingAttempt(attempt.id);
  assert.equal(recorded.status, 'result-submitted');
  assert.equal(recorded.verification, null);
  assert.equal(recorded.verdict, null);
});

test('ignores a late worker Result after the owner stops an Attempt', async (t) => {
  await useTemporaryStateDirectory(t);
  const { attempt } = await createAttemptFixture();
  await dispatchAttempt(attempt.id);
  const eventsPath = kingAttemptEventsPath(attempt.taskId, attempt.id);
  await writeFile(
    join(eventsPath, 'started.json'),
    JSON.stringify({ schemaVersion: 1, attemptId: attempt.id, startedAt: 160 })
  );
  await scanKingAttemptEvents(attempt.id, 170);
  await decideKingAttempt(
    attempt.id,
    { outcome: 'rejected', reason: 'Owner stopped the active worker.', decidedBy: 'owner' },
    180
  );
  await writeFile(
    join(eventsPath, 'result.json'),
    JSON.stringify({
      schemaVersion: 1,
      attemptId: attempt.id,
      status: 'succeeded',
      summary: 'This late Result must not revive the Attempt.',
      changedPaths: [],
      verification: [],
      blockers: [],
    })
  );

  const scan = await scanKingAttemptEvents(attempt.id, 190);

  assert.equal(scan[0]?.result, 'unchanged');
  assert.equal((await readKingAttempt(attempt.id)).status, 'rejected');
});

test('detects a changed event file and requires owner review instead of accepting the rewrite', async (t) => {
  await useTemporaryStateDirectory(t);
  const { attempt } = await createAttemptFixture();
  await dispatchAttempt(attempt.id);
  const eventsPath = kingAttemptEventsPath(attempt.taskId, attempt.id);
  await writeFile(
    join(eventsPath, 'started.json'),
    JSON.stringify({ schemaVersion: 1, attemptId: attempt.id, startedAt: 160 })
  );
  const resultPath = join(eventsPath, 'result.json');
  await writeFile(
    resultPath,
    JSON.stringify({
      schemaVersion: 1,
      attemptId: attempt.id,
      status: 'succeeded',
      summary: 'First claim',
      changedPaths: [],
      verification: [],
      blockers: [],
    })
  );
  await scanKingAttemptEvents(attempt.id, 200);
  await writeFile(
    resultPath,
    JSON.stringify({
      schemaVersion: 1,
      attemptId: attempt.id,
      status: 'succeeded',
      summary: 'Rewritten claim',
      changedPaths: [],
      verification: [],
      blockers: [],
    })
  );
  const scan = await scanKingAttemptEvents(attempt.id, 300);
  assert.equal(scan[0]?.result, 'conflict');
  assert.equal((await readKingAttempt(attempt.id)).status, 'needs-owner');
  const inboxCount = (await readKingWorkflowStore()).inbox.length;
  assert.equal((await scanKingAttemptEvents(attempt.id, 400))[0]?.result, 'unchanged');
  assert.equal((await readKingWorkflowStore()).inbox.length, inboxCount);
});

test('enforces verification and approval gates before completing a Task', async (t) => {
  await useTemporaryStateDirectory(t);
  const { run, attempt } = await createAttemptFixture();
  await dispatchAttempt(attempt.id);
  await writeFile(
    join(kingAttemptEventsPath(attempt.taskId, attempt.id), 'started.json'),
    JSON.stringify({ schemaVersion: 1, attemptId: attempt.id, startedAt: 160 })
  );
  const resultPath = join(kingAttemptEventsPath(attempt.taskId, attempt.id), 'result.json');
  await writeFile(
    resultPath,
    JSON.stringify({
      schemaVersion: 1,
      attemptId: attempt.id,
      status: 'succeeded',
      summary: 'Verified change',
      changedPaths: ['src/feature.ts'],
      verification: [{ command: 'pnpm test:node', outcome: 'passed' }],
      blockers: [],
    })
  );
  await scanKingAttemptEvents(attempt.id, 200);
  await assert.rejects(
    () => decideKingAttempt(attempt.id, { outcome: 'accepted', reason: 'looks good', decidedBy: 'king' }, 210),
    /not been verified/i
  );
  await recordKingAttemptVerification(
    attempt.id,
    {
      outcome: 'passed',
      checkedAt: 220,
      actualChanges: [{ path: 'src/feature.ts', status: ' M' }],
      attemptChangePaths: ['src/feature.ts'],
      unexpectedPaths: [],
      baselineDirty: false,
      baselineHeadRevision: null,
      currentHeadRevision: null,
      headRevisionChanged: false,
      commands: [
        {
          command: 'pnpm test:node',
          outcome: 'passed',
          exitCode: 0,
          stdout: 'ok',
          stderr: '',
          durationMs: 10,
        },
      ],
      reasons: [],
    },
    220
  );
  await decideKingAttempt(
    attempt.id,
    { outcome: 'accepted', reason: 'Diff and independent checks passed.', decidedBy: 'king' },
    230
  );
  assert.equal((await readKingAttempt(attempt.id)).status, 'accepted');
  assert.equal((await readKingRun(run.id)).run.status, 'completed');
});

test('preserves a worker-blocked Result as blocked after independent verification', async (t) => {
  await useTemporaryStateDirectory(t);
  const { run, attempt } = await createAttemptFixture();
  await dispatchAttempt(attempt.id);
  const eventsPath = kingAttemptEventsPath(attempt.taskId, attempt.id);
  await writeFile(
    join(eventsPath, 'started.json'),
    JSON.stringify({ schemaVersion: 1, attemptId: attempt.id, startedAt: 160 })
  );
  await writeFile(
    join(eventsPath, 'result.json'),
    JSON.stringify({
      schemaVersion: 1,
      attemptId: attempt.id,
      status: 'blocked',
      summary: 'A required credential is unavailable.',
      changedPaths: [],
      verification: [{ command: 'pnpm test:node', outcome: 'not-run' }],
      blockers: ['Missing credential'],
    })
  );
  await scanKingAttemptEvents(attempt.id, 200);
  const verified = await recordKingAttemptVerification(
    attempt.id,
    {
      outcome: 'failed',
      checkedAt: 220,
      actualChanges: [],
      attemptChangePaths: [],
      unexpectedPaths: [],
      baselineDirty: false,
      baselineHeadRevision: null,
      currentHeadRevision: null,
      headRevisionChanged: false,
      commands: [],
      reasons: ['Worker Result status is blocked.'],
    },
    220
  );
  assert.equal(verified.status, 'blocked');
  assert.equal((await readKingRun(run.id)).tasks[0]?.status, 'blocked');
});

test('blocks dependent Tasks and surfaces a passed owner-policy verification for explicit approval', async (t) => {
  await useTemporaryStateDirectory(t);
  const run = await createKingRun({
    title: 'Ordered work',
    objective: 'Complete Tasks in dependency order.',
    planningPolicy: 'direct',
  });
  const prerequisite = await createKingTask({
    runId: run.id,
    workspaceId: 'workspace-1',
    title: 'Prerequisite',
    objective: 'Prepare the shared API.',
    acceptanceCriteria: ['API is ready'],
  });
  const dependent = await createKingTask({
    runId: run.id,
    workspaceId: 'workspace-2',
    title: 'Dependent',
    objective: 'Use the shared API.',
    dependsOnTaskIds: [prerequisite.id],
    acceptanceCriteria: ['Consumer works'],
  });
  await assert.rejects(
    () =>
      createKingAttempt(dependent.id, {
        capturedAt: 1,
        isGitRepository: true,
        headRevision: null,
        changes: [],
        dirty: false,
      }),
    /waiting for dependencies/i
  );

  const ownerTask = await createKingTask({
    runId: run.id,
    workspaceId: 'workspace-3',
    title: 'Owner gate',
    objective: 'Make a sensitive but verifiable change.',
    acceptanceCriteria: ['The check passes'],
    verificationCommands: ['pnpm test'],
    approvalPolicy: 'owner',
  });
  const ownerAttempt = await createKingAttempt(ownerTask.id, {
    capturedAt: 1,
    isGitRepository: true,
    headRevision: null,
    changes: [],
    dirty: false,
  });
  await dispatchAttempt(ownerAttempt.id, 10);
  const eventsPath = kingAttemptEventsPath(ownerTask.id, ownerAttempt.id);
  await writeFile(
    join(eventsPath, 'started.json'),
    JSON.stringify({ schemaVersion: 1, attemptId: ownerAttempt.id, startedAt: 12 })
  );
  await writeFile(
    join(eventsPath, 'result.json'),
    JSON.stringify({
      schemaVersion: 1,
      attemptId: ownerAttempt.id,
      status: 'succeeded',
      summary: 'Sensitive change complete.',
      changedPaths: ['src/sensitive.ts'],
      verification: [{ command: 'pnpm test', outcome: 'passed' }],
      blockers: [],
    })
  );
  await scanKingAttemptEvents(ownerAttempt.id, 20);
  const verified = await recordKingAttemptVerification(
    ownerAttempt.id,
    {
      outcome: 'passed',
      checkedAt: 30,
      actualChanges: [{ path: 'src/sensitive.ts', status: ' M' }],
      attemptChangePaths: ['src/sensitive.ts'],
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
          stdout: 'ok',
          stderr: '',
          durationMs: 5,
        },
      ],
      reasons: [],
    },
    30
  );
  assert.equal(verified.status, 'needs-owner');
  assert.equal(verified.verdict?.decidedBy, 'vampire');
  await assert.rejects(
    () => decideKingAttempt(ownerAttempt.id, { outcome: 'accepted', reason: 'King accepts', decidedBy: 'king' }, 31),
    /owner decision/i
  );
  const accepted = await decideKingAttempt(
    ownerAttempt.id,
    { outcome: 'accepted', reason: 'Owner reviewed the sensitive diff.', decidedBy: 'owner' },
    32
  );
  assert.equal(accepted.status, 'accepted');
  const ownerDecision = (await readKingWorkflowStore()).inbox.find((event) => event.type === 'owner-decision');
  assert.equal(ownerDecision?.attemptId, ownerAttempt.id);
  assert.match(ownerDecision?.message ?? '', /owner approved/i);
});

test('gates managed work behind a read-only plan and an authenticated owner answer', async (t) => {
  await useTemporaryStateDirectory(t);
  const run = await createKingRun(
    {
      title: 'Find and change the right project',
      objective: 'Add the requested behavior to the best matching workspace.',
      ownerRequest: '  내 요청 그대로 보존\n두 번째 줄  ',
      workspaceIds: ['workspace-1'],
    },
    { now: 100 }
  );
  assert.equal(run.planningPolicy, 'managed');
  assert.equal(run.phase, 'intake');
  assert.equal(run.ownerRequest, '  내 요청 그대로 보존\n두 번째 줄  ');

  await assert.rejects(
    () =>
      createKingTask({
        runId: run.id,
        workspaceId: 'workspace-1',
        kind: 'change',
        title: 'Too early',
        objective: 'Change the repository before plan approval.',
        acceptanceCriteria: ['It works'],
      }),
    /accepted analysis plan/i
  );

  const analysis = await createKingTask(
    {
      runId: run.id,
      workspaceId: 'workspace-1',
      kind: 'analysis',
      title: 'Analyze candidate',
      objective: 'Inspect this project and propose a bounded implementation plan.',
      acceptanceCriteria: ['Return a structured plan'],
      approvalPolicy: 'auto',
    },
    110
  );
  const attempt = await createKingAttempt(
    analysis.id,
    { capturedAt: 120, isGitRepository: true, headRevision: 'a'.repeat(40), changes: [], dirty: false },
    120
  );
  await dispatchAttempt(attempt.id, 130);
  const eventsPath = kingAttemptEventsPath(analysis.id, attempt.id);
  await writeFile(
    join(eventsPath, 'started.json'),
    JSON.stringify({ schemaVersion: 1, attemptId: attempt.id, startedAt: 132 })
  );
  await writeFile(
    join(eventsPath, 'result.json'),
    JSON.stringify({
      schemaVersion: 1,
      attemptId: attempt.id,
      status: 'succeeded',
      summary: 'This is the matching project.',
      changedPaths: [],
      verification: [],
      blockers: [],
      plan: {
        candidateWorkspaceId: 'workspace-1',
        recommendation: 'proceed',
        confidence: 0.82,
        summary: 'Change one bounded feature and add its regression test.',
        steps: ['Update the feature', 'Add a regression test'],
        assumptions: ['The current API remains stable'],
        risks: ['One compatibility edge case needs owner confirmation'],
        questions: [],
        proposedTasks: [
          {
            workspaceId: 'workspace-1',
            title: 'Implement bounded feature',
            objective: 'Implement the approved behavior.',
            acceptanceCriteria: ['The behavior works', 'The regression test passes'],
            allowedPaths: ['src', 'tests'],
            forbiddenPaths: ['.env'],
            verificationCommands: ['pnpm test'],
            approvalPolicy: 'auto',
          },
        ],
      },
    })
  );
  await scanKingAttemptEvents(attempt.id, 140);
  const verified = await recordKingAttemptVerification(
    attempt.id,
    {
      outcome: 'passed',
      checkedAt: 150,
      actualChanges: [],
      attemptChangePaths: [],
      unexpectedPaths: [],
      baselineDirty: false,
      baselineHeadRevision: 'a'.repeat(40),
      currentHeadRevision: 'a'.repeat(40),
      headRevisionChanged: false,
      commands: [],
      reasons: [],
    },
    150
  );
  assert.equal(verified.status, 'verified');

  const question = await createKingDecisionRequest(
    {
      attemptId: attempt.id,
      question: 'Keep compatibility with the legacy response shape?',
      context: 'The plan can support either shape, but the choice changes the public API.',
      options: ['Keep compatibility', 'Use the new shape'],
    },
    160
  );
  assert.equal((await readKingRun(run.id)).run.phase, 'needs-owner');
  await assert.rejects(
    () => decideKingAttempt(attempt.id, { outcome: 'accepted', reason: 'Plan looks good.', decidedBy: 'king' }, 170),
    /owner answer/i
  );

  await answerKingDecisionRequest(question.id, 'Keep compatibility', 180);
  assert.equal((await readKingRun(run.id)).run.phase, 'analyzing');
  await decideKingAttempt(
    attempt.id,
    { outcome: 'accepted', reason: 'The verified plan incorporates the owner answer.', decidedBy: 'king' },
    190
  );
  const approved = await readKingRun(run.id);
  assert.equal(approved.run.status, 'active');
  assert.equal(approved.run.phase, 'approved');
  assert.equal(approved.decisions[0]?.answer, 'Keep compatibility');

  await createKingTask(
    {
      runId: run.id,
      workspaceId: 'workspace-1',
      kind: 'change',
      title: 'Implement bounded feature',
      objective: 'Implement the approved behavior while keeping compatibility.',
      acceptanceCriteria: ['The behavior works', 'The regression test passes'],
      allowedPaths: ['src', 'tests'],
      forbiddenPaths: ['.env'],
      verificationCommands: ['pnpm test'],
      approvalPolicy: 'auto',
    },
    200
  );
  assert.equal((await readKingRun(run.id)).run.phase, 'executing');
});

test('bounds a managed candidate shortlist to three workspaces', async (t) => {
  await useTemporaryStateDirectory(t);
  await assert.rejects(
    () =>
      createKingRun({
        title: 'Too many candidates',
        objective: 'Analyze every project at once.',
        workspaceIds: ['one', 'two', 'three', 'four'],
      }),
    /at most three/i
  );
});

test('leases a repository checkout across duplicate workspace registrations', async (t) => {
  await useTemporaryStateDirectory(t);
  const run = await createKingRun({
    title: 'Avoid colliding writers',
    objective: 'Run independent work safely.',
    planningPolicy: 'direct',
  });
  const first = await createKingTask({
    runId: run.id,
    workspaceId: 'workspace-a',
    kind: 'change',
    title: 'First writer',
    objective: 'Change the first area.',
    acceptanceCriteria: ['Done'],
  });
  const second = await createKingTask({
    runId: run.id,
    workspaceId: 'workspace-b',
    kind: 'change',
    title: 'Second writer',
    objective: 'Change the second area.',
    acceptanceCriteria: ['Done'],
  });
  await createKingAttempt(first.id, {
    capturedAt: 1,
    workspaceLeaseKey: '/same/repository/checkout',
    isGitRepository: true,
    headRevision: null,
    changes: [],
    dirty: false,
  });
  await assert.rejects(
    () =>
      createKingAttempt(second.id, {
        capturedAt: 2,
        workspaceLeaseKey: '/same/repository/checkout',
        isGitRepository: true,
        headRevision: null,
        changes: [],
        dirty: false,
      }),
    /isolated worktree/i
  );
});

test('interrupts active workspace Attempts once when the owner takes control', async (t) => {
  await useTemporaryStateDirectory(t);
  const { attempt } = await createAttemptFixture();

  const interrupted = await interruptKingWorkspaceAttempts(
    'workspace-1',
    'The owner took control of this checkout.',
    200
  );
  assert.deepEqual(
    interrupted.map((candidate) => candidate.id),
    [attempt.id]
  );
  assert.equal(interrupted[0]?.status, 'blocked');
  assert.equal(interrupted[0]?.verdict?.decidedBy, 'owner');

  const stored = await readKingWorkflowStore();
  assert.equal(stored.tasks[0]?.status, 'blocked');
  assert.equal(stored.inbox.at(-1)?.type, 'attempt-interrupted');
  assert.deepEqual(await interruptKingWorkspaceAttempts('workspace-1', 'Repeated owner action.', 201), []);
});

test('cancels active workflow state while retaining acknowledged audit history', async (t) => {
  await useTemporaryStateDirectory(t);
  const { run, task, attempt } = await createAttemptFixture();

  const cancelled = await cancelActiveKingWorkflow('The owner removed the King workspace.', 300);
  assert.deepEqual(cancelled.runIds, [run.id]);
  assert.deepEqual(cancelled.taskIds, [task.id]);
  assert.deepEqual(cancelled.attemptIds, [attempt.id]);

  const stored = await readKingWorkflowStore();
  assert.equal(stored.runs[0]?.status, 'cancelled');
  assert.equal(stored.runs[0]?.phase, 'cancelled');
  assert.equal(stored.tasks[0]?.status, 'blocked');
  assert.equal(stored.attempts[0]?.status, 'blocked');
  assert.equal(stored.inbox.at(-1)?.type, 'attempt-interrupted');
  assert.equal(stored.inbox.at(-1)?.notifiedAt, 300);
  assert.equal(stored.inbox.at(-1)?.acknowledgedAt, 300);
  assert.deepEqual(await cancelActiveKingWorkflow('Already cancelled.', 301), {
    runIds: [],
    taskIds: [],
    attemptIds: [],
    decisionIds: [],
  });
});
