import { error, json, type RequestHandler } from '@sveltejs/kit';
import { requireAuthentication } from '~/lib/features/auth/server/auth.server.ts';
import {
  answerKingDecisionRequest,
  decideKingAttempt,
  KingWorkflowError,
  readKingWorkflowStore,
  readKingWorkflowSummary,
  resumeKingAttemptPreparation,
} from '~/lib/features/workspace/server/king-workflow-store.server.ts';
import { readWorkspaceStore, type StoredWorkspace } from '~/lib/features/workspace/server/workspace-store.server.ts';
import { interruptTmuxTerminal } from '~/lib/features/terminal/server/tmux.server.ts';

const ACTIVE_ATTEMPT_STATUSES = new Set([
  'queued',
  'delivery-uncertain',
  'dispatched',
  'working',
  'result-submitted',
  'verified',
  'needs-owner',
]);

function workspaceControlRequest(workspace: StoredWorkspace) {
  const control = workspace.kingControl;
  if (control?.state !== 'requested') return undefined;
  return {
    id: workspace.id,
    label: workspace.workspaceLabel || workspace.cwd,
    cwd: workspace.cwd,
    control,
  };
}

export const GET: RequestHandler = async (event) => {
  requireAuthentication(event);
  const [store, summary, workspaceStore] = await Promise.all([
    readKingWorkflowStore(),
    readKingWorkflowSummary(),
    readWorkspaceStore(),
  ]);
  const activeAttempts = store.attempts.filter((attempt) => ACTIVE_ATTEMPT_STATUSES.has(attempt.status));
  const recentAttempts = store.attempts.filter((attempt) => !ACTIVE_ATTEMPT_STATUSES.has(attempt.status)).slice(-20);
  const relevantAttempts = activeAttempts.concat(recentAttempts);
  const relevantDecisionAttemptIds = new Set(
    store.decisions.filter((decision) => decision.status === 'pending').map((decision) => decision.attemptId)
  );
  for (const attempt of store.attempts) {
    if (
      relevantDecisionAttemptIds.has(attempt.id) &&
      !relevantAttempts.some((candidate) => candidate.id === attempt.id)
    ) {
      relevantAttempts.push(attempt);
    }
  }
  const taskIds = new Set(relevantAttempts.map((attempt) => attempt.taskId));
  const runIds = new Set(relevantAttempts.map((attempt) => attempt.runId));
  for (const run of store.runs) {
    if (run.status === 'active' || run.status === 'needs-owner') runIds.add(run.id);
  }
  return json(
    {
      summary,
      runs: store.runs.filter((run) => runIds.has(run.id)).slice(-20),
      tasks: store.tasks.filter((task) => taskIds.has(task.id) || runIds.has(task.runId)).slice(-50),
      attempts: [...new Map(relevantAttempts.map((attempt) => [attempt.id, attempt])).values()],
      decisions: store.decisions
        .filter((decision) => decision.status === 'pending' || runIds.has(decision.runId))
        .slice(-50),
      inbox: store.inbox.slice(-20).reverse(),
      workspaceLabels: Object.fromEntries(
        workspaceStore.workspaces.map((workspace) => [
          workspace.id,
          workspace.workspaceKind === 'king' ? 'The King of Vampire' : workspace.workspaceLabel || workspace.cwd,
        ])
      ),
      controlRequests: workspaceStore.workspaces.flatMap((workspace) => {
        const request = workspaceControlRequest(workspace);
        return request ? [request] : [];
      }),
    },
    { headers: { 'cache-control': 'no-store' } }
  );
};

export const POST: RequestHandler = async (event) => {
  requireAuthentication(event);
  const body: unknown = await event.request.json().catch(() => undefined);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw error(400, 'Decision input is required.');
  const input = body as Record<string, unknown>;
  if (input.action === 'retry') {
    if (typeof input.attemptId !== 'string') throw error(400, 'Attempt id is required.');
    const store = await readKingWorkflowStore();
    const attempt = store.attempts.find((candidate) => candidate.id === input.attemptId);
    if (!attempt) throw error(404, 'King Attempt was not found.');
    const reason = attempt.verdict?.outcome === 'owner-required' ? attempt.verdict.reason : undefined;
    if (!reason) throw error(409, 'This King Attempt cannot retry delivery preparation.');
    try {
      return json({ attempt: await resumeKingAttemptPreparation(attempt.id, reason) });
    } catch (cause) {
      if (cause instanceof KingWorkflowError) throw error(409, cause.message);
      throw error(500, 'Vampire could not retry the King Attempt.');
    }
  }
  if (input.action === 'answer') {
    if (typeof input.decisionId !== 'string') throw error(400, 'Decision id is required.');
    if (typeof input.answer !== 'string' || !input.answer.trim()) throw error(400, 'Owner answer is required.');
    try {
      const decision = await answerKingDecisionRequest(input.decisionId, input.answer);
      return json({ decision });
    } catch (cause) {
      if (cause instanceof KingWorkflowError) throw error(409, cause.message);
      throw error(500, 'Vampire could not record the owner answer.');
    }
  }
  if (input.action === 'cancel') {
    if (typeof input.attemptId !== 'string') throw error(400, 'Attempt id is required.');
    const store = await readKingWorkflowStore();
    const attempt = store.attempts.find((candidate) => candidate.id === input.attemptId);
    if (!attempt) throw error(404, 'King Attempt was not found.');
    if (!ACTIVE_ATTEMPT_STATUSES.has(attempt.status)) throw error(409, 'King Attempt is not active.');
    const reason =
      typeof input.reason === 'string' && input.reason.trim()
        ? input.reason
        : `Owner stopped King Attempt ${attempt.id} from its workspace.`;
    try {
      if (attempt.deliveryTarget) {
        await interruptTmuxTerminal(attempt.deliveryTarget.tmuxSession, attempt.deliveryTarget.terminalId);
      }
      const cancelled = await decideKingAttempt(attempt.id, {
        outcome: 'rejected',
        reason,
        decidedBy: 'owner',
      });
      return json({ attempt: cancelled });
    } catch (cause) {
      if (cause instanceof KingWorkflowError) throw error(409, cause.message);
      throw error(500, 'Vampire could not stop the King Attempt.');
    }
  }
  if (input.action !== 'decide') throw error(400, 'Unsupported King workflow action.');
  if (typeof input.attemptId !== 'string') throw error(400, 'Attempt id is required.');
  if (input.outcome !== 'accepted' && input.outcome !== 'rejected') {
    throw error(400, 'Decision outcome must be accepted or rejected.');
  }
  if (typeof input.reason !== 'string' || !input.reason.trim()) throw error(400, 'Decision reason is required.');
  try {
    const attempt = await decideKingAttempt(input.attemptId, {
      outcome: input.outcome,
      reason: input.reason,
      decidedBy: 'owner',
    });
    return json({ attempt });
  } catch (cause) {
    if (cause instanceof KingWorkflowError) throw error(409, cause.message);
    throw error(500, 'Vampire could not record the owner decision.');
  }
};
