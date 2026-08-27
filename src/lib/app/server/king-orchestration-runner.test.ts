import assert from 'node:assert/strict';
import test from 'node:test';
import type { TmuxSession, TmuxTerminal } from '~/lib/features/terminal/server/tmux.server.ts';
import type { KingAttempt, KingInboxEvent, KingTask, KingWorkflowStore } from '~/lib/shared/contracts/king-workflow.ts';
import { type KingOrchestrationDependencies, runKingOrchestrationTick } from './king-orchestration-runner.server.ts';

function attempt(status: KingAttempt['status']): KingAttempt {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    runId: '22222222-2222-4222-8222-222222222222',
    taskId: '33333333-3333-4333-8333-333333333333',
    workspaceId: 'worker',
    status,
    taskPacketPath: '/state/king/tasks/task/attempts/attempt/task.json',
    baseline: { capturedAt: 1, isGitRepository: true, headRevision: null, changes: [], dirty: false },
    deliveryTarget: null,
    result: null,
    verification: null,
    verdict: null,
    startedEventHash: null,
    startedEventConflictHash: null,
    resultEventHash: null,
    resultEventConflictHash: null,
    createdAt: 1,
    updatedAt: 1,
    deliveryAttemptedAt: status === 'delivery-uncertain' ? 10 : null,
    dispatchedAt: null,
    startedAt: null,
    resultSubmittedAt: null,
  };
}

function task(kind: KingTask['kind'] = 'change'): KingTask {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    runId: '22222222-2222-4222-8222-222222222222',
    workspaceId: 'worker',
    kind,
    title: kind === 'analysis' ? 'Analyze candidate' : 'Implement change',
    objective: 'Handle the owner request.',
    background: '',
    nonGoals: [],
    dependsOnTaskIds: [],
    acceptanceCriteria: ['Return the required result.'],
    allowedPaths: [],
    forbiddenPaths: [],
    verificationCommands: kind === 'analysis' ? [] : ['pnpm test'],
    approvalPolicy: 'auto',
    status: 'queued',
    createdAt: 1,
    updatedAt: 1,
    completedAt: null,
  };
}

function workflow(attempts: KingAttempt[], tasks: KingTask[] = [task()]): KingWorkflowStore {
  return { version: 2, runs: [], tasks, attempts, decisions: [], inbox: [] };
}

function tmuxSession(name: string): TmuxSession {
  const mainTerminal = {
    id: name === 'worker-session' ? '@1' : '@2',
    index: 0,
    name: 'main',
    active: true,
    lastOutputAt: 1,
    foregroundProcess: { kind: 'command' as const, label: 'codex' },
    command: null,
    startedAt: 1,
    state: 'running' as const,
    exitCode: null,
    terminalKind: 'main' as const,
    kingAttemptId: null,
  };
  const terminals: TmuxTerminal[] = [mainTerminal];
  if (name === 'worker-session') {
    terminals.push({
      ...mainTerminal,
      id: '@3',
      index: 1,
      name: 'king-task',
      terminalKind: 'king-task',
      kingAttemptId: attempt('queued').id,
    });
  }
  return {
    name,
    createdAt: 1,
    lastOutputAt: 1,
    attachedClients: 0,
    foregroundProcess: { kind: 'command', label: 'codex' },
    terminals,
  };
}

function grantedKingControl() {
  return {
    state: 'king' as const,
    reason: 'Owner handed this workspace to King.',
    requestedAt: 1,
    changedAt: 1,
    lastAction: 'granted' as const,
    notifiedAt: 1,
    handoffSnapshot: null,
  };
}

function inboxEvent(type: KingInboxEvent['type'] = 'attempt-started', target = attempt('working')): KingInboxEvent {
  return {
    id: 'event-1',
    type,
    runId: target.runId,
    taskId: target.taskId,
    attemptId: target.id,
    workspaceId: target.workspaceId,
    message: type,
    createdAt: 1,
    notifiedAt: null,
    acknowledgedAt: null,
  };
}

function dependencies(
  currentWorkflow: KingWorkflowStore,
  overrides: Partial<KingOrchestrationDependencies> = {}
): KingOrchestrationDependencies {
  return {
    ensureKing: async () => ({
      name: 'King',
      cwd: '/state/king',
      instructionsPath: '/state/king/KING.md',
      packagePath: '/state/king/package.json',
      cliPath: '/state/king/bin/king.mjs',
      controlConfigPath: '/state/king/control.json',
      controlSocketPath: '/tmp/vampire-king/control.sock',
      bootstrapVersion: 8,
      contractRevision: '8-revision',
      bootstrapPrompt: 'bootstrap',
    }),
    readWorkspaceStore: async () => ({
      version: 1,
      launchProfiles: [{ id: 'codex', name: 'Codex', command: 'codex --profile worker' }],
      workspaces: [
        {
          id: 'worker',
          tmuxSession: 'worker-session',
          cwd: '/worker',
          createdAt: 1,
          lastActiveAt: 1,
          automations: [],
          favoriteCommands: [],
          startupProfileId: 'codex',
          kingControl: grantedKingControl(),
        },
        {
          id: 'king',
          tmuxSession: 'king-session',
          cwd: '/state/king',
          workspaceKind: 'king',
          createdAt: 1,
          lastActiveAt: 1,
          automations: [],
          favoriteCommands: [],
          startupProfileId: null,
        },
      ],
    }),
    readWorkflowStore: async () => currentWorkflow,
    scanEvents: async () => [],
    listInbox: async () => [],
    markInboxNotified: async () => [],
    markDeliveryUncertain: async (id) => ({ ...attempt('delivery-uncertain'), id }),
    markDispatched: async (id) => ({ ...attempt('dispatched'), id }),
    requireOwner: async (id) => ({ ...attempt('needs-owner'), id }),
    verifyAttempt: async (id) => ({ ...attempt('verified'), id }),
    listTmuxSessions: async () => [tmuxSession('worker-session'), tmuxSession('king-session')],
    readAgentStates: async (workspaces) => new Map([...workspaces].map((workspace) => [workspace.id, 'waiting'])),
    readTerminalAgentState: async () => 'waiting',
    killTerminal: async () => undefined,
    markControlNotified: async () => {
      throw new Error('Control notification was not expected.');
    },
    submitPrompt: async () => {},
    ...overrides,
  } as KingOrchestrationDependencies;
}

test('dispatches a queued packet to the existing main agent without routing on its inferred activity', async () => {
  const prompts: Array<{ session: string; terminal: string; prompt: string }> = [];
  const transitions: string[] = [];
  let deliveryTarget: KingAttempt['deliveryTarget'] = null;
  let notifiedIds: string[] = [];
  const queued = attempt('queued');
  const event = inboxEvent();
  const workerSession = tmuxSession('worker-session');
  workerSession.terminals = workerSession.terminals.filter((terminal) => terminal.terminalKind === 'main');
  await runKingOrchestrationTick(
    100,
    dependencies(workflow([queued]), {
      listTmuxSessions: async () => [workerSession, tmuxSession('king-session')],
      readTerminalAgentState: async () => {
        throw new Error('Main-agent dispatch must not inspect coarse activity state.');
      },
      listInbox: async () => [event],
      markDeliveryUncertain: async (id, target) => {
        transitions.push(`uncertain:${id}`);
        deliveryTarget = target ?? null;
        return { ...queued, status: 'delivery-uncertain' };
      },
      markDispatched: async (id) => {
        transitions.push(`dispatched:${id}`);
        return { ...queued, status: 'dispatched' };
      },
      submitPrompt: async (session, terminal, prompt) => {
        prompts.push({ session, terminal, prompt });
      },
      markInboxNotified: async (ids) => {
        notifiedIds = ids;
        return [event];
      },
    })
  );

  assert.deepEqual(transitions, [`uncertain:${queued.id}`, `dispatched:${queued.id}`]);
  assert.equal(prompts[0]?.session, 'worker-session');
  assert.match(prompts[0]?.prompt ?? '', new RegExp(queued.id));
  assert.match(prompts[0]?.prompt ?? '', /event started/);
  assert.match(prompts[0]?.prompt ?? '', /event result/);
  assert.match(prompts[0]?.prompt ?? '', /Do not commit/);
  assert.deepEqual(deliveryTarget, {
    tmuxSession: 'worker-session',
    terminalId: '@1',
    agentLabel: 'codex',
  });
  assert.equal(prompts.length, 1);
  assert.deepEqual(notifiedIds, []);
});

test('wakes King for an actionable verified Result and keeps its visible agent until judgment', async () => {
  const prompts: string[] = [];
  const notifiedIds: string[] = [];
  const cleanupAttempts: string[] = [];
  const verified = attempt('verified');
  const event = inboxEvent('verification-complete', verified);
  await runKingOrchestrationTick(
    100,
    dependencies(workflow([verified]), {
      listInbox: async () => [event],
      submitPrompt: async (_session, _terminal, prompt) => {
        prompts.push(prompt);
      },
      markInboxNotified: async (ids) => {
        notifiedIds.push(...ids);
        return [event];
      },
      killTerminal: async (session, terminalId) => {
        cleanupAttempts.push(`${session}:${terminalId}`);
        throw new Error('Transient cleanup failure');
      },
    })
  );

  assert.equal(prompts.length, 1);
  assert.match(prompts[0] ?? '', /verification-complete/);
  assert.match(prompts[0] ?? '', /Do not repeat a worker analysis/);
  assert.match(prompts[0] ?? '', /Do not .*poll, or wait/);
  assert.deepEqual(notifiedIds, [event.id]);
  assert.deepEqual(cleanupAttempts, []);
});

test('leaves owner-gated verification to the authenticated UI instead of waking King', async () => {
  const prompts: string[] = [];
  const needsOwner = attempt('needs-owner');
  await runKingOrchestrationTick(
    100,
    dependencies(workflow([needsOwner]), {
      listInbox: async () => [inboxEvent('verification-complete', needsOwner)],
      submitPrompt: async (_session, _terminal, prompt) => {
        prompts.push(prompt);
      },
    })
  );
  assert.deepEqual(prompts, []);
});

test('wakes King after an authenticated owner decision', async () => {
  const prompts: string[] = [];
  const accepted = attempt('accepted');
  const event = inboxEvent('owner-decision', accepted);
  await runKingOrchestrationTick(
    100,
    dependencies(workflow([accepted]), {
      listInbox: async () => [event],
      submitPrompt: async (_session, _terminal, prompt) => {
        prompts.push(prompt);
      },
    })
  );

  assert.equal(prompts.length, 1);
  assert.match(prompts[0] ?? '', /owner-decision/);
});

test('does not materialize or scan King state before a King workspace is registered', async () => {
  let ensureCalls = 0;
  let workflowReads = 0;
  await runKingOrchestrationTick(
    100,
    dependencies(workflow([]), {
      ensureKing: async () => {
        ensureCalls += 1;
        throw new Error('King should not be prepared.');
      },
      readWorkspaceStore: async () => ({ version: 1, launchProfiles: [], workspaces: [] }),
      readWorkflowStore: async () => {
        workflowReads += 1;
        return workflow([]);
      },
    })
  );
  assert.equal(ensureCalls, 0);
  assert.equal(workflowReads, 0);
});

test('never silently resends an uncertain delivery and escalates it after the grace period', async () => {
  const uncertain = attempt('delivery-uncertain');
  const ownerReviews: string[] = [];
  const prompts: string[] = [];
  await runKingOrchestrationTick(
    30_011,
    dependencies(workflow([uncertain]), {
      requireOwner: async (id, reason) => {
        ownerReviews.push(`${id}:${reason}`);
        return { ...uncertain, status: 'needs-owner' };
      },
      submitPrompt: async (_session, _terminal, prompt) => {
        prompts.push(prompt);
      },
    })
  );
  assert.equal(ownerReviews.length, 1);
  assert.match(ownerReviews[0] ?? '', /will not resend/i);
  assert.deepEqual(prompts, []);
});

test('refuses to invent an agent session when a running workspace contains only a shell', async () => {
  const queued = attempt('queued');
  const ownerReviews: string[] = [];
  const prompts: string[] = [];
  const workerSession = tmuxSession('worker-session');
  workerSession.terminals = workerSession.terminals.filter((terminal) => terminal.terminalKind === 'main');
  workerSession.terminals[0] = {
    ...workerSession.terminals[0]!,
    foregroundProcess: { kind: 'shell', label: 'zsh' },
  };
  await runKingOrchestrationTick(
    100,
    dependencies(workflow([queued]), {
      listTmuxSessions: async () => [workerSession, tmuxSession('king-session')],
      requireOwner: async (id, reason) => {
        ownerReviews.push(`${id}:${reason}`);
        return { ...queued, status: 'needs-owner' };
      },
      submitPrompt: async (_session, _terminal, prompt) => {
        prompts.push(prompt);
      },
    })
  );

  assert.equal(ownerReviews.length, 1);
  assert.match(ownerReviews[0] ?? '', /no recognized main agent.*start Codex or Claude manually/i);
  assert.deepEqual(prompts, []);
});

test('does not start a stopped workspace to deliver a queued Attempt', async () => {
  const queued = attempt('queued');
  const ownerReviews: string[] = [];

  await runKingOrchestrationTick(
    100,
    dependencies(workflow([queued]), {
      listTmuxSessions: async () => [tmuxSession('king-session')],
      requireOwner: async (id, reason) => {
        ownerReviews.push(`${id}:${reason}`);
        return { ...queued, status: 'needs-owner' };
      },
    })
  );

  assert.equal(ownerReviews.length, 1);
  assert.match(ownerReviews[0] ?? '', /stopped.*open it manually/i);
});

test('escalates a task terminal that never becomes ready instead of waiting forever', async () => {
  const queued = attempt('queued');
  const ownerReviews: string[] = [];
  const prompts: string[] = [];

  await runKingOrchestrationTick(
    30_001,
    dependencies(workflow([queued]), {
      readTerminalAgentState: async () => null,
      requireOwner: async (id, reason) => {
        ownerReviews.push(`${id}:${reason}`);
        return { ...queued, status: 'needs-owner' };
      },
      submitPrompt: async (_session, _terminal, prompt) => {
        prompts.push(prompt);
      },
    })
  );

  assert.equal(ownerReviews.length, 1);
  assert.match(ownerReviews[0] ?? '', /did not become ready within 30 seconds/i);
  assert.deepEqual(prompts, []);
});

test('escalates dispatched and working Attempts that never report progress', async () => {
  const dispatched = { ...attempt('dispatched'), dispatchedAt: 1 };
  const working = { ...attempt('working'), startedAt: 1 };
  const ownerReviews: string[] = [];

  await runKingOrchestrationTick(
    60 * 60_000 + 1,
    dependencies(workflow([dispatched, working]), {
      requireOwner: async (id, reason) => {
        ownerReviews.push(`${id}:${reason}`);
        return { ...attempt('needs-owner'), id };
      },
    })
  );

  assert.equal(ownerReviews.length, 2);
  assert.match(ownerReviews.join('\n'), /did not report its start within 2 minutes/i);
  assert.match(ownerReviews.join('\n'), /did not submit a Result within 60 minutes/i);
});

test('dispatches analysis with a read-only structured plan contract', async () => {
  const prompts: string[] = [];
  const queued = attempt('queued');
  await runKingOrchestrationTick(
    100,
    dependencies(workflow([queued], [task('analysis')]), {
      submitPrompt: async (_session, _terminal, prompt) => {
        prompts.push(prompt);
      },
    })
  );
  assert.equal(prompts.length, 1);
  assert.match(prompts[0] ?? '', /read-only analysis/i);
  assert.match(prompts[0] ?? '', /Do not create, edit, delete/i);
  assert.match(prompts[0] ?? '', /candidateWorkspaceId/);
  assert.match(prompts[0] ?? '', /proposedTasks/);
});

test('automatically verifies a submitted Result before notifying King', async () => {
  const submitted = attempt('result-submitted');
  const verified: string[] = [];
  await runKingOrchestrationTick(
    200,
    dependencies(workflow([submitted]), {
      verifyAttempt: async (id, now) => {
        verified.push(`${id}:${now}`);
        return { ...submitted, status: 'verified' };
      },
    })
  );
  assert.deepEqual(verified, [`${submitted.id}:200`]);
});

test('does not escalate when a concurrent verifier already finished the Attempt', async () => {
  const submitted = attempt('result-submitted');
  const finished = { ...submitted, status: 'verified' as const };
  let reads = 0;
  let ownerEscalations = 0;
  await runKingOrchestrationTick(
    300,
    dependencies(workflow([submitted]), {
      readWorkflowStore: async () => (reads++ === 0 ? workflow([submitted]) : workflow([finished])),
      verifyAttempt: async () => {
        throw new Error('Another verifier won the race.');
      },
      requireOwner: async (id) => {
        ownerEscalations += 1;
        return { ...finished, id };
      },
    })
  );
  assert.equal(ownerEscalations, 0);
});
