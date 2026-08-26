import { render, screen, waitFor } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import type { KingAttempt } from '~/lib/shared/contracts/king-workflow.ts';
import KingWorkflowPanel from './KingWorkflowPanel.svelte';

function ownerAttempt(): KingAttempt {
  return {
    id: 'attempt-1',
    runId: 'run-1',
    taskId: 'task-1',
    workspaceId: 'workspace-1',
    status: 'needs-owner',
    taskPacketPath: '/packet.json',
    baseline: { capturedAt: 1, isGitRepository: true, headRevision: null, changes: [], dirty: true },
    deliveryTarget: null,
    result: {
      schemaVersion: 1,
      attemptId: 'attempt-1',
      status: 'succeeded',
      summary: 'Implemented the requested change.',
      changedPaths: ['src/feature.ts'],
      verification: [{ command: 'pnpm test', outcome: 'passed' }],
      blockers: [],
      plan: null,
    },
    verification: {
      outcome: 'needs-owner',
      checkedAt: 2,
      actualChanges: [{ path: 'src/feature.ts', status: ' M' }],
      attemptChangePaths: ['src/feature.ts'],
      unexpectedPaths: [],
      baselineDirty: true,
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
      reasons: ['The baseline was already dirty.'],
    },
    verdict: {
      outcome: 'owner-required',
      reason: 'Dirty baseline',
      decidedBy: 'vampire',
      decidedAt: 2,
    },
    startedEventHash: 'started',
    startedEventConflictHash: null,
    resultEventHash: 'result',
    resultEventConflictHash: null,
    createdAt: 1,
    updatedAt: 2,
    deliveryAttemptedAt: 1,
    dispatchedAt: 1,
    startedAt: 1,
    resultSubmittedAt: 2,
  };
}

function setupBlockedAttempt(): KingAttempt {
  return {
    ...ownerAttempt(),
    result: null,
    verification: null,
    verdict: {
      outcome: 'owner-required',
      reason: 'Select a startup profile before King dispatches work to this workspace.',
      decidedBy: 'vampire',
      decidedAt: 2,
    },
    startedEventHash: null,
    resultEventHash: null,
    deliveryAttemptedAt: null,
    dispatchedAt: null,
    startedAt: null,
    resultSubmittedAt: null,
  };
}

const response = {
  summary: {
    activeRuns: 1,
    activeTasks: 1,
    queuedAttempts: 0,
    needsOwner: 1,
    pendingDecisions: 0,
    pendingInbox: 2,
    recentInbox: [],
  },
  runs: [
    {
      id: 'run-1',
      title: 'Ship the feature',
      objective: 'Ship safely',
      ownerRequest: 'Ship safely',
      workspaceIds: ['workspace-1'],
      planningPolicy: 'direct' as const,
      phase: 'needs-owner' as const,
      status: 'needs-owner' as const,
      contractRevision: '2-revision',
      createdAt: 1,
      updatedAt: 2,
      completedAt: null,
    },
  ],
  tasks: [
    {
      id: 'task-1',
      runId: 'run-1',
      workspaceId: 'workspace-1',
      kind: 'change' as const,
      title: 'Implement feature',
      objective: 'Implement it',
      background: '',
      nonGoals: [],
      dependsOnTaskIds: [],
      acceptanceCriteria: ['Works'],
      allowedPaths: ['src'],
      forbiddenPaths: [],
      verificationCommands: ['pnpm test'],
      approvalPolicy: 'owner' as const,
      status: 'needs-owner' as const,
      createdAt: 1,
      updatedAt: 2,
      completedAt: null,
    },
  ],
  attempts: [ownerAttempt()],
  decisions: [],
  inbox: [],
  controlRequests: [],
};

afterEach(() => vi.unstubAllGlobals());

test('opens from an urgent header control and approves with one click', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return new Response(JSON.stringify(init?.method === 'POST' ? { attempt: ownerAttempt() } : response), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    })
  );
  const user = userEvent.setup();
  render(KingWorkflowPanel);

  const trigger = await screen.findByRole('button', { name: 'Open King orchestration, 1 item needs you' });
  expect(screen.queryByRole('heading', { name: 'Owner decisions' })).not.toBeInTheDocument();
  await user.click(trigger);
  expect(await screen.findByText('Owner decisions', { selector: 'h2' })).toBeInTheDocument();
  expect(screen.getByText('The baseline was already dirty.')).toBeInTheDocument();
  const approve = screen.getByText('Approve', { selector: 'button' });
  expect(approve).toBeEnabled();
  await user.click(approve);

  await waitFor(() => expect(requests.some((request) => request.init?.method === 'POST')).toBe(true));
  const decision = requests.find((request) => request.init?.method === 'POST');
  assertDecisionBody(decision?.init?.body);
});

test('shows an undelivered setup failure without asking for an impossible approval', async () => {
  const setupResponse = { ...response, attempts: [setupBlockedAttempt()] };
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify(setupResponse), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    )
  );
  const user = userEvent.setup();
  render(KingWorkflowPanel);

  await user.click(await screen.findByRole('button', { name: 'Open King orchestration' }));

  expect(await screen.findByText('Setup issues', { selector: 'h2' })).toBeInTheDocument();
  expect(screen.getByText(/Select a startup profile/)).toBeInTheDocument();
  expect(screen.getByText(/No approval is needed/)).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Owner decisions' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  expect(screen.queryByText('Rationale (optional)')).not.toBeInTheDocument();
  expect(screen.getByText('Cancel attempt', { selector: 'button' })).toBeEnabled();
});

function assertDecisionBody(body: BodyInit | null | undefined) {
  expect(typeof body).toBe('string');
  if (typeof body !== 'string') return;
  expect(JSON.parse(body)).toEqual({
    action: 'decide',
    attemptId: 'attempt-1',
    outcome: 'accepted',
    reason: 'Owner approved Implement feature after reviewing the verified evidence.',
  });
}

test('shows a focused King question and sends the authenticated owner answer', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const questionResponse = {
    ...response,
    summary: { ...response.summary, pendingDecisions: 1 },
    decisions: [
      {
        id: 'decision-1',
        runId: 'run-1',
        taskId: 'task-1',
        attemptId: 'attempt-1',
        workspaceId: 'workspace-1',
        question: 'Keep the legacy response shape?',
        context: 'This choice affects compatibility.',
        options: ['Keep compatibility', 'Use the new shape'],
        status: 'pending' as const,
        answer: null,
        createdAt: 3,
        answeredAt: null,
      },
    ],
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return new Response(
        JSON.stringify(init?.method === 'POST' ? { decision: questionResponse.decisions[0] } : questionResponse),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      );
    })
  );
  const user = userEvent.setup();
  render(KingWorkflowPanel);

  await user.click(await screen.findByRole('button', { name: 'Open King orchestration, 2 items need you' }));
  expect(await screen.findByText('Questions from King', { selector: 'h2' })).toBeInTheDocument();
  await user.click(screen.getByText('Keep compatibility', { selector: 'button' }));
  await user.click(screen.getByText('Send answer', { selector: 'button' }));

  await waitFor(() => expect(requests.some((request) => request.init?.method === 'POST')).toBe(true));
  const answerRequest = requests.find((request) => request.init?.method === 'POST');
  expect(typeof answerRequest?.init?.body).toBe('string');
  if (typeof answerRequest?.init?.body !== 'string') return;
  expect(JSON.parse(answerRequest.init.body)).toEqual({
    action: 'answer',
    decisionId: 'decision-1',
    answer: 'Keep compatibility',
  });
});

test('approves a workspace handoff directly from King orchestration', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  let handedOver = false;
  const control = {
    state: 'requested' as const,
    reason: 'Use the existing worktree for the approved change.',
    requestedAt: 3,
    changedAt: 3,
    lastAction: 'requested' as const,
    notifiedAt: 3,
    handoffSnapshot: null,
  };
  const handoffResponse = {
    ...response,
    summary: { ...response.summary, needsOwner: 0 },
    attempts: [],
    controlRequests: handedOver
      ? []
      : [
          {
            id: 'workspace-1',
            label: 'Feature worktree',
            cwd: '/project-feature',
            startupProfileId: 'codex',
            control,
          },
        ],
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (init?.method === 'POST' && url.includes('/king-control')) handedOver = true;
      const body = url.includes('/king-control')
        ? { control: { ...control, state: 'king', lastAction: 'granted' }, interruptedAttemptIds: [] }
        : { ...handoffResponse, controlRequests: handedOver ? [] : handoffResponse.controlRequests };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    })
  );
  const user = userEvent.setup();
  render(KingWorkflowPanel);

  await user.click(await screen.findByRole('button', { name: 'Open King orchestration, 1 item needs you' }));
  expect(await screen.findByText('Workspace handoffs', { selector: 'h2' })).toBeInTheDocument();
  await user.click(screen.getByText('Hand over', { selector: 'button' }));

  await waitFor(() => expect(handedOver).toBe(true));
  const handoff = requests.find((request) => request.url.includes('/king-control'));
  expect(handoff?.init?.method).toBe('POST');
  expect(typeof handoff?.init?.body).toBe('string');
  if (typeof handoff?.init?.body !== 'string') return;
  expect(JSON.parse(handoff.init.body)).toEqual({ action: 'handoff' });
});
