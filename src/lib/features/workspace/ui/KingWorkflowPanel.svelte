<script lang="ts">
import { onMount } from 'svelte';
import Crown from '@lucide/svelte/icons/crown';
import ShieldCheck from '@lucide/svelte/icons/shield-check';
import type {
  KingAttempt,
  KingDecisionRequest,
  KingInboxEvent,
  KingRun,
  KingTask,
  KingWorkflowSummary,
} from '~/lib/shared/contracts/king-workflow.ts';
import { kingAttemptCanRetryPreparation } from '~/lib/shared/contracts/king-workflow.ts';
import type { WorkspaceKingControl } from '~/lib/shared/contracts/workspace.ts';
import { requestJson } from '~/lib/shared/api/request.ts';
import Button from '~/lib/shared/ui/Button.svelte';
import PopoverShell from '~/lib/shared/ui/PopoverShell.svelte';

const KING_REFRESH_TIMEOUT_MS = 10_000;
const KING_ACTION_TIMEOUT_MS = 60_000;

type WorkflowResponse = {
  summary: KingWorkflowSummary;
  runs: KingRun[];
  tasks: KingTask[];
  attempts: KingAttempt[];
  decisions: KingDecisionRequest[];
  inbox: KingInboxEvent[];
  workspaceLabels: Record<string, string>;
  controlRequests: WorkspaceControlRequest[];
};

type WorkspaceControlRequest = {
  id: string;
  label: string;
  cwd: string;
  control: WorkspaceKingControl & { state: 'requested' };
};

type OwnerReviewAttempt = KingAttempt & {
  result: NonNullable<KingAttempt['result']>;
  verification: NonNullable<KingAttempt['verification']>;
};

let open = $state(false);
let loading = $state(true);
let errorMessage = $state('');
let decidingAttemptId = $state<string>();
let answeringDecisionId = $state<string>();
let controllingWorkspaceId = $state<string>();
let retryingAttemptId = $state<string>();
let decisionReasons = $state<Record<string, string>>({});
let ownerAnswers = $state<Record<string, string>>({});
let workflow = $state<WorkflowResponse>();
const ACTIVE_ATTEMPT_STATUSES = new Set<KingAttempt['status']>([
  'queued',
  'delivery-uncertain',
  'dispatched',
  'working',
  'result-submitted',
  'verified',
]);
const TERMINAL_ATTEMPT_STATUSES = new Set<KingAttempt['status']>(['accepted', 'rejected', 'blocked', 'failed']);
function needsOwnerReview(attempt: KingAttempt): attempt is OwnerReviewAttempt {
  return attempt.status === 'needs-owner' && attempt.result !== null && attempt.verification !== null;
}

const ownerAttempts = $derived(workflow?.attempts.filter(needsOwnerReview) ?? []);
const attentionAttempts = $derived(
  workflow?.attempts.filter(
    (attempt) => attempt.status === 'needs-owner' && (attempt.result === null || attempt.verification === null)
  ) ?? []
);
const activeAttempts = $derived(
  workflow?.attempts.filter((attempt) => ACTIVE_ATTEMPT_STATUSES.has(attempt.status)) ?? []
);
const recentAttempts = $derived(
  (workflow?.attempts.filter((attempt) => TERMINAL_ATTEMPT_STATUSES.has(attempt.status)) ?? []).slice(-5).reverse()
);
const pendingDecisions = $derived(workflow?.decisions.filter((decision) => decision.status === 'pending') ?? []);
const activeRuns = $derived(
  workflow?.runs.filter((run) => run.status === 'active' || run.status === 'needs-owner') ?? []
);
const ownerActionCount = $derived(
  ownerAttempts.length + pendingDecisions.length + (workflow?.controlRequests.length ?? 0)
);
const attentionCount = $derived(ownerActionCount + attentionAttempts.length);

function orchestrationTriggerLabel(actionCount: number): string {
  if (actionCount === 0) return 'Open King orchestration';
  const itemLabel = actionCount === 1 ? 'item needs' : 'items need';
  return `Open King orchestration, ${actionCount} ${itemLabel} attention`;
}

function attentionSummary(actionCount: number): string {
  return `${actionCount} ${actionCount === 1 ? 'needs' : 'need'} attention`;
}

function activeGoalSummary(goalCount: number): string {
  return `${goalCount} ${goalCount === 1 ? 'goal' : 'goals'}`;
}

const triggerLabel = $derived(orchestrationTriggerLabel(attentionCount));

function taskFor(attempt: KingAttempt): KingTask | undefined {
  return workflow?.tasks.find((task) => task.id === attempt.taskId);
}

function workspaceLabel(workspaceId: string): string {
  return workflow?.workspaceLabels[workspaceId] ?? workspaceId;
}

function attemptStage(attempt: KingAttempt): string {
  if (attempt.status === 'queued') return 'Preparing assignment';
  if (attempt.status === 'delivery-uncertain') return 'Confirming delivery';
  if (attempt.status === 'dispatched') return 'Waiting for the agent to start';
  if (attempt.status === 'working') return 'Agent is working';
  if (attempt.status === 'result-submitted') return 'Checking the submitted result';
  if (attempt.status === 'verified') return 'Waiting for King to review the verified result';
  return attempt.status;
}

function runPhaseLabel(phase: KingRun['phase']): string {
  if (phase === 'intake') return 'Choosing a workspace';
  if (phase === 'analyzing') return 'Analyzing';
  if (phase === 'needs-owner') return 'Needs attention';
  if (phase === 'approved') return 'Plan ready';
  if (phase === 'executing') return 'Working';
  if (phase === 'verifying') return 'Checking results';
  if (phase === 'completed') return 'Completed';
  return 'Cancelled';
}

function attemptOutcome(attempt: KingAttempt): string {
  if (attempt.status === 'accepted') return taskFor(attempt)?.kind === 'analysis' ? 'Analysis accepted' : 'Completed';
  if (attempt.status === 'rejected') return 'Not accepted';
  if (attempt.status === 'blocked') return 'Blocked';
  return 'Failed';
}

function attentionGuidance(attempt: KingAttempt): string {
  const reason = attempt.verdict?.reason ?? '';
  if (/no recognized main agent/i.test(reason)) {
    return 'Start Codex or Claude in this workspace, then retry the assignment.';
  }
  if (/workspace .* is stopped/i.test(reason)) {
    return 'Open the workspace and start its agent manually, then retry the assignment.';
  }
  if (kingAttemptCanRetryPreparation(attempt)) {
    return 'Resolve the setup issue, then retry. No approval is required.';
  }
  return 'No approval is possible because no verified result exists. Cancel this attempt and ask King to create a fresh one.';
}

function defaultDecisionReason(attempt: KingAttempt, outcome: 'accepted' | 'rejected'): string {
  const subject = taskFor(attempt)?.title ?? `Attempt ${attempt.id}`;
  if (outcome === 'accepted') return `Owner approved ${subject} after reviewing the verified evidence.`;
  if (!attempt.verification) return `Owner cancelled ${subject} before a verified Result existed.`;
  return `Owner rejected ${subject} after reviewing the available evidence.`;
}

function updateReason(attemptId: string, value: string) {
  decisionReasons = { ...decisionReasons, [attemptId]: value };
}

function updateAnswer(decisionId: string, value: string) {
  ownerAnswers = { ...ownerAnswers, [decisionId]: value };
}

async function refresh() {
  try {
    const next = await requestJson<WorkflowResponse>('/api/king/workflow', undefined, 'Loading King orchestration', {
      timeoutMs: KING_REFRESH_TIMEOUT_MS,
    });
    workflow = next;
    errorMessage = '';
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : 'Unable to load King workflow state.';
  } finally {
    loading = false;
  }
}

async function decide(attempt: KingAttempt, outcome: 'accepted' | 'rejected') {
  const reason = decisionReasons[attempt.id]?.trim() || defaultDecisionReason(attempt, outcome);
  decidingAttemptId = attempt.id;
  errorMessage = '';
  try {
    await requestJson(
      '/api/king/workflow',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'decide', attemptId: attempt.id, outcome, reason }),
      },
      'Recording the owner decision',
      { timeoutMs: KING_ACTION_TIMEOUT_MS }
    );
    decisionReasons = Object.fromEntries(Object.entries(decisionReasons).filter(([id]) => id !== attempt.id));
    await refresh();
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : 'Unable to record the owner decision.';
  } finally {
    decidingAttemptId = undefined;
  }
}

async function answer(decision: KingDecisionRequest) {
  const ownerAnswer = ownerAnswers[decision.id]?.trim();
  if (!ownerAnswer) return;
  answeringDecisionId = decision.id;
  errorMessage = '';
  try {
    await requestJson(
      '/api/king/workflow',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'answer', decisionId: decision.id, answer: ownerAnswer }),
      },
      'Recording the owner answer',
      { timeoutMs: KING_ACTION_TIMEOUT_MS }
    );
    ownerAnswers = Object.fromEntries(Object.entries(ownerAnswers).filter(([id]) => id !== decision.id));
    await refresh();
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : 'Unable to record the owner answer.';
  } finally {
    answeringDecisionId = undefined;
  }
}

async function retryPreparation(attempt: KingAttempt) {
  retryingAttemptId = attempt.id;
  errorMessage = '';
  try {
    await requestJson(
      '/api/king/workflow',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'retry', attemptId: attempt.id }),
      },
      'Retrying the King assignment',
      { timeoutMs: KING_ACTION_TIMEOUT_MS }
    );
    await refresh();
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : 'Unable to retry the King assignment.';
  } finally {
    retryingAttemptId = undefined;
  }
}

async function decideWorkspaceControl(request: WorkspaceControlRequest, action: 'handoff' | 'decline') {
  controllingWorkspaceId = request.id;
  errorMessage = '';
  try {
    await requestJson(
      `/api/workspaces/${encodeURIComponent(request.id)}/king-control`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      },
      'Changing workspace control',
      { timeoutMs: KING_ACTION_TIMEOUT_MS }
    );
    await refresh();
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : 'Unable to change workspace control.';
  } finally {
    controllingWorkspaceId = undefined;
  }
}

onMount(() => {
  void refresh();
  const timer = window.setInterval(() => void refresh(), 2_000);
  return () => window.clearInterval(timer);
});
</script>

<PopoverShell
  bind:open
  align="end"
  side="bottom"
  sideOffset={14}
  trapFocus={true}
  contentClass="king-workflow-popover"
  contentLabel="King orchestration"
  contentRole="dialog"
  triggerClass={`king-workflow-button${open ? ' active' : ''}`}
  triggerLabel={open ? 'Close King orchestration' : triggerLabel}
  triggerTitle={open ? 'Close King orchestration' : triggerLabel}
>
  {#snippet trigger()}
    <Crown size={16} strokeWidth={1.9} aria-hidden="true" />
    {#if attentionCount > 0}
      <span class="king-workflow-button__count">{attentionCount > 99 ? '99+' : attentionCount}</span>
    {/if}
  {/snippet}

  {#snippet children()}
    <div class="king-workflow" data-vampire-overlay>
      <header class="king-workflow__header">
        <span class="king-workflow__heading">
          <Crown size={16} strokeWidth={1.9} aria-hidden="true" />
          <strong>King orchestration</strong>
        </span>
        {#if workflow}
          <span class="king-workflow__metric">{activeGoalSummary(workflow.summary.activeRuns)}</span>
          {#if attentionCount > 0}
            <span class="king-workflow__alert">{attentionSummary(attentionCount)}</span>
          {/if}
        {:else if loading}
          <span class="king-workflow__metric">loading</span>
        {/if}
      </header>
      <div id="king-workflow-content" class="king-workflow__content">
        {#if errorMessage}
          <p class="king-workflow__error" role="alert">{errorMessage}</p>
        {/if}

        {#if workflow?.controlRequests.length}
          <section aria-labelledby="king-handoffs-title">
            <h2 id="king-handoffs-title">Workspace handoffs</h2>
            {#each workflow.controlRequests as request (request.id)}
              <article class="king-decision">
                <div class="king-decision__heading">
                  <Crown size={15} strokeWidth={1.8} aria-hidden="true" />
                  <strong>{request.label}</strong>
                  <small>{request.cwd}</small>
                </div>
                <p>{request.control.reason}</p>
                <div class="king-decision__actions">
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={controllingWorkspaceId === request.id}
                    onclick={() => void decideWorkspaceControl(request, 'handoff')}
                    >Hand over</Button
                  >
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={controllingWorkspaceId === request.id}
                    onclick={() => void decideWorkspaceControl(request, 'decline')}
                    >Keep manual</Button
                  >
                </div>
              </article>
            {/each}
          </section>
        {/if}

        {#if pendingDecisions.length > 0}
          <section aria-labelledby="king-questions-title">
            <h2 id="king-questions-title">Questions from King</h2>
            {#each pendingDecisions as decision (decision.id)}
              {@const attempt = workflow?.attempts.find((candidate) => candidate.id === decision.attemptId)}
              <article class="king-decision">
                <div class="king-decision__heading">
                  <Crown size={15} strokeWidth={1.8} aria-hidden="true" />
                  <strong>{decision.question}</strong>
                  <small>{workspaceLabel(decision.workspaceId)}</small>
                </div>
                {#if decision.context}
                  <p>{decision.context}</p>
                {/if}
                {#if attempt?.result?.plan}
                  <p class="king-decision__plan">Plan: {attempt.result.plan.summary}</p>
                {/if}
                {#if decision.options.length > 0}
                  <div class="king-decision__options" aria-label="Suggested answers">
                    {#each decision.options as option}
                      <button type="button" onclick={() => updateAnswer(decision.id, option)}>{option}</button>
                    {/each}
                  </div>
                {/if}
                <label>
                  <span>Your answer</span>
                  <textarea
                    rows="3"
                    value={ownerAnswers[decision.id] ?? ''}
                    placeholder="Answer King with the missing decision or constraint"
                    oninput={(event) => updateAnswer(decision.id, event.currentTarget.value)}
                  ></textarea>
                </label>
                <div class="king-decision__actions">
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={!ownerAnswers[decision.id]?.trim() || answeringDecisionId === decision.id}
                    onclick={() => void answer(decision)}
                    >Send answer</Button
                  >
                </div>
              </article>
            {/each}
          </section>
        {/if}

        {#if ownerAttempts.length > 0}
          <section aria-labelledby="king-owner-title">
            <h2 id="king-owner-title">Approval needed</h2>
            {#each ownerAttempts as attempt (attempt.id)}
              {@const task = taskFor(attempt)}
              <article class="king-decision">
                <div class="king-decision__heading">
                  <ShieldCheck size={15} strokeWidth={1.8} aria-hidden="true" />
                  <strong>{task?.title ?? attempt.taskId}</strong>
                  <small>{workspaceLabel(attempt.workspaceId)}</small>
                </div>
                <p>{attempt.result.summary}</p>
                <dl>
                  <div>
                    <dt>Verification</dt>
                    <dd>{attempt.verification.outcome}</dd>
                  </div>
                  <div>
                    <dt>Changed</dt>
                    <dd>{attempt.verification.attemptChangePaths.length}</dd>
                  </div>
                  <div>
                    <dt>Checks</dt>
                    <dd>
                      {attempt.verification.commands.filter((command) => command.outcome === 'passed').length}/{attempt.verification.commands.length}
                    </dd>
                  </div>
                </dl>
                {#if attempt.verification.reasons.length > 0}
                  <ul>
                    {#each attempt.verification.reasons as reason}
                      <li>{reason}</li>
                    {/each}
                  </ul>
                {/if}
                <label>
                  <span>Rationale (optional)</span>
                  <textarea
                    rows="2"
                    value={decisionReasons[attempt.id] ?? ''}
                    placeholder="Add context only when the default decision record is not enough"
                    oninput={(event) => updateReason(attempt.id, event.currentTarget.value)}
                  ></textarea>
                </label>
                <div class="king-decision__actions">
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={attempt.verification.outcome === 'failed' || decidingAttemptId === attempt.id}
                    onclick={() => void decide(attempt, 'accepted')}
                    >Approve</Button
                  >
                  <Button
                    size="sm"
                    variant="danger-outline"
                    disabled={decidingAttemptId === attempt.id}
                    onclick={() => void decide(attempt, 'rejected')}
                    >Reject</Button
                  >
                </div>
              </article>
            {/each}
          </section>
        {/if}

        {#if attentionAttempts.length > 0}
          <section aria-labelledby="king-attention-title">
            <h2 id="king-attention-title">Attention needed</h2>
            {#each attentionAttempts as attempt (attempt.id)}
              {@const task = taskFor(attempt)}
              <article class="king-decision">
                <div class="king-decision__heading">
                  <Crown size={15} strokeWidth={1.8} aria-hidden="true" />
                  <strong>{task?.title ?? attempt.taskId}</strong>
                  <small>{workspaceLabel(attempt.workspaceId)}</small>
                </div>
                <p class="king-decision__warning">
                  {attempt.verdict?.reason ?? 'Vampire could not prepare this Attempt.'}
                </p>
                <p>{attentionGuidance(attempt)}</p>
                <div class="king-decision__actions">
                  {#if kingAttemptCanRetryPreparation(attempt)}
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={retryingAttemptId === attempt.id}
                      onclick={() => void retryPreparation(attempt)}
                      >Retry assignment</Button
                    >
                  {/if}
                  <Button
                    size="sm"
                    variant="danger-outline"
                    disabled={decidingAttemptId === attempt.id}
                    onclick={() => void decide(attempt, 'rejected')}
                    >Cancel attempt</Button
                  >
                </div>
              </article>
            {/each}
          </section>
        {/if}

        <section aria-labelledby="king-work-title">
          <h2 id="king-work-title">Current work</h2>
          {#if activeAttempts.length === 0}
            <p class="king-workflow__empty">No assignment is running right now.</p>
          {:else}
            <ul class="king-work">
              {#each activeAttempts as attempt (attempt.id)}
                {@const task = taskFor(attempt)}
                <li>
                  <div>
                    <strong>{task?.title ?? 'King assignment'}</strong>
                    <small>{workspaceLabel(attempt.workspaceId)}</small>
                  </div>
                  <span>{attemptStage(attempt)}</span>
                </li>
              {/each}
            </ul>
          {/if}
        </section>

        <section aria-labelledby="king-runs-title">
          <h2 id="king-runs-title">Active goals</h2>
          {#if activeRuns.length === 0}
            <p class="king-workflow__empty">No active goal. Tell King what you want to do next.</p>
          {:else}
            <ul class="king-runs">
              {#each activeRuns as run (run.id)}
                <li><span>{run.title}</span><small>{runPhaseLabel(run.phase)}</small></li>
              {/each}
            </ul>
          {/if}
        </section>

        {#if recentAttempts.length > 0}
          <section aria-labelledby="king-outcomes-title">
            <h2 id="king-outcomes-title">Recent outcomes</h2>
            <ul class="king-outcomes">
              {#each recentAttempts as attempt (attempt.id)}
                {@const task = taskFor(attempt)}
                <li>
                  <div>
                    <strong>{task?.title ?? 'King assignment'}</strong>
                    <small>{workspaceLabel(attempt.workspaceId)}</small>
                  </div>
                  {#if attempt.result?.summary}
                    <p>{attempt.result.summary}</p>
                  {:else if attempt.verdict?.reason}
                    <p>{attempt.verdict.reason}</p>
                  {/if}
                  <span>{attemptOutcome(attempt)}</span>
                </li>
              {/each}
            </ul>
          </section>
        {/if}
      </div>
    </div>
  {/snippet}
</PopoverShell>

<style>
:global(.king-workflow-button) {
  color: var(--color-warning-accent);
}
:global(.king-workflow-button__count) {
  background: var(--color-warning-action) !important;
  color: var(--color-warning-text-strong) !important;
}
:global(.king-workflow-popover) {
  z-index: 45;
  width: min(32rem, calc(100vw - 1rem));
  max-width: calc(100vw - 1rem);
  max-height: calc(100dvh - 5rem);
  overflow: hidden;
  border: 1px solid var(--color-warning-border);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--color-panel) 98%, transparent);
  box-shadow: var(--shadow-popover);
  color: var(--color-text);
  backdrop-filter: blur(10px);
}
.king-workflow {
  display: grid;
  min-width: 0;
  max-height: calc(100dvh - 5rem);
}
.king-workflow__header {
  display: flex;
  align-items: center;
  min-height: 2.5rem;
  flex-wrap: wrap;
  gap: 0.45rem;
  padding: 0.4rem 0.6rem;
  background: var(--color-warning-surface);
  color: var(--color-warning-text);
}
.king-workflow__heading {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  gap: 0.4rem;
  margin-right: auto;
  color: var(--color-warning-accent);
}
.king-workflow__heading strong {
  color: var(--color-warning-text);
  font-size: var(--text-label);
}
.king-workflow__metric,
.king-workflow__alert {
  padding: 0.15rem 0.38rem;
  border-radius: 999px;
  font-size: var(--text-micro);
  white-space: nowrap;
}
.king-workflow__metric {
  background: var(--color-surface);
  color: var(--color-text-secondary);
}
.king-workflow__alert {
  background: var(--color-warning-action);
  color: var(--color-warning-text-strong);
}
.king-workflow__content {
  display: grid;
  min-height: 0;
  max-height: min(42rem, calc(100dvh - 7.5rem));
  gap: 1rem;
  overflow-y: auto;
  padding: 0.75rem;
}
.king-workflow__content section {
  display: grid;
  gap: 0.45rem;
}
.king-workflow__content h2 {
  margin: 0;
  color: var(--color-text-secondary);
  font-size: var(--text-caption);
  font-weight: var(--weight-strong);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.king-workflow__error,
.king-workflow__empty,
.king-decision p {
  margin: 0;
  font-size: var(--text-caption);
  line-height: var(--leading-body);
}
.king-workflow__error {
  color: var(--color-danger);
}
.king-workflow__empty {
  color: var(--color-text-tertiary);
}
.king-decision {
  display: grid;
  gap: 0.55rem;
  padding: 0.65rem;
  border: 1px solid var(--color-warning-border-soft);
  border-radius: var(--radius-sm);
  background: var(--color-warning-surface-strong);
}
.king-decision__heading {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 0.4rem;
  color: var(--color-warning-text);
}
.king-decision__heading strong {
  overflow: hidden;
  margin-right: auto;
  font-size: var(--text-label);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.king-decision__heading small {
  overflow: hidden;
  max-width: 45%;
  color: var(--color-text-tertiary);
  font-size: var(--text-micro);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.king-decision dl {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem 0.8rem;
  margin: 0;
  font-size: var(--text-micro);
}
.king-decision dl div {
  display: flex;
  gap: 0.25rem;
}
.king-decision dt {
  color: var(--color-text-tertiary);
}
.king-decision dd {
  margin: 0;
  color: var(--color-text);
}
.king-decision ul {
  margin: 0;
  padding-left: 1rem;
  color: var(--color-warning-text-secondary);
  font-size: var(--text-micro);
}
.king-decision__warning {
  color: var(--color-warning-text-secondary);
}
.king-decision__plan {
  color: var(--color-text-secondary);
}
.king-decision__options {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}
.king-decision__options button {
  padding: 0.25rem 0.45rem;
  border: 1px solid var(--color-warning-border);
  border-radius: 999px;
  background: var(--color-surface);
  color: var(--color-text-secondary);
  cursor: pointer;
  font: inherit;
  font-size: var(--text-micro);
}
.king-decision__options button:hover {
  color: var(--color-text);
}
.king-decision label {
  display: grid;
  gap: 0.3rem;
  color: var(--color-text-secondary);
  font-size: var(--text-micro);
}
.king-decision textarea {
  width: 100%;
  resize: vertical;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-xs);
  background: var(--color-field-background);
  color: var(--color-text);
  font: inherit;
  font-size: var(--text-caption);
  line-height: var(--leading-body);
  padding: 0.45rem;
}
.king-decision textarea:focus-visible {
  outline: none;
  box-shadow: var(--shadow-accent-focus);
}
.king-decision__actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.4rem;
}
.king-runs,
.king-work,
.king-outcomes {
  display: grid;
  gap: 0.35rem;
  margin: 0;
  padding: 0;
  list-style: none;
}
.king-runs li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  font-size: var(--text-caption);
}
.king-runs small {
  color: var(--color-text-tertiary);
}
.king-work li,
.king-outcomes li {
  display: grid;
  gap: 0.3rem;
  padding: 0.55rem 0.6rem;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
}
.king-work li > div,
.king-outcomes li > div {
  display: flex;
  align-items: baseline;
  min-width: 0;
  gap: 0.45rem;
}
.king-work strong,
.king-outcomes strong {
  overflow: hidden;
  color: var(--color-text);
  font-size: var(--text-caption);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.king-work small,
.king-outcomes small {
  overflow: hidden;
  color: var(--color-text-tertiary);
  font-size: var(--text-micro);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.king-work span,
.king-outcomes span {
  color: var(--color-warning-text-secondary);
  font-size: var(--text-micro);
}
.king-outcomes p {
  margin: 0;
  color: var(--color-text-secondary);
  font-size: var(--text-micro);
  line-height: var(--leading-body);
}
.king-outcomes li {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
}
.king-outcomes li > div,
.king-outcomes li > p {
  grid-column: 1;
}
.king-outcomes li > span {
  grid-column: 2;
  grid-row: 1;
}
@media (max-width: 36rem) {
  :global(.king-workflow-popover) {
    width: calc(100vw - 0.75rem);
    max-width: calc(100vw - 0.75rem);
    max-height: calc(100dvh - 4.75rem - env(safe-area-inset-bottom));
  }
  .king-workflow {
    max-height: calc(100dvh - 4.75rem - env(safe-area-inset-bottom));
  }
  .king-workflow__content {
    max-height: calc(100dvh - 7.5rem - env(safe-area-inset-bottom));
  }
}
</style>
