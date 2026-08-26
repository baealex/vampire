<script lang="ts">
import CircleStop from '@lucide/svelte/icons/circle-stop';
import Crown from '@lucide/svelte/icons/crown';
import SquareTerminal from '@lucide/svelte/icons/square-terminal';
import { onMount } from 'svelte';
import type { KingAttempt, KingTask } from '~/lib/shared/contracts/king-workflow.ts';
import type { WorkspaceTerminal } from '~/lib/shared/contracts/workspace.ts';
import { requestJson } from '~/lib/shared/api/request.ts';
import Button from '~/lib/shared/ui/Button.svelte';

const KING_ACTION_TIMEOUT_MS = 60_000;
const KING_REFRESH_TIMEOUT_MS = 10_000;
const ACTIVE_ATTEMPT_STATUSES = new Set<KingAttempt['status']>([
  'queued',
  'delivery-uncertain',
  'dispatched',
  'working',
  'result-submitted',
  'verified',
  'needs-owner',
]);

type WorkflowResponse = { attempts: KingAttempt[]; tasks: KingTask[] };

let { workspaceId, mainTerminal, taskTerminals, selectedTerminalId, onSelect } = $props<{
  workspaceId: string;
  mainTerminal: WorkspaceTerminal | undefined;
  taskTerminals: WorkspaceTerminal[];
  selectedTerminalId: string | undefined;
  onSelect: (terminalId: string | undefined) => void;
}>();

let stoppingAttemptId = $state<string>();
let errorMessage = $state('');
let workflow = $state<WorkflowResponse>();
const activeAttempts = $derived(
  workflow?.attempts.filter(
    (attempt: KingAttempt) => attempt.workspaceId === workspaceId && ACTIVE_ATTEMPT_STATUSES.has(attempt.status)
  ) ?? []
);
const selectedTask = $derived(taskTerminals.find((terminal: WorkspaceTerminal) => terminal.id === selectedTerminalId));
const selectedAttempt = $derived(
  activeAttempts.find(
    (attempt: KingAttempt) =>
      attempt.deliveryTarget?.terminalId === selectedTerminalId || attempt.id === selectedTask?.kingAttemptId
  )
);
const selectedAttemptId = $derived(selectedAttempt?.id ?? selectedTask?.kingAttemptId);
const visible = $derived(taskTerminals.length > 0 || activeAttempts.length > 0);

function attemptForTerminal(terminal: WorkspaceTerminal | undefined): KingAttempt | undefined {
  if (!terminal) return undefined;
  return activeAttempts.find(
    (attempt: KingAttempt) =>
      attempt.deliveryTarget?.terminalId === terminal.id || attempt.id === terminal.kingAttemptId
  );
}

function attemptLabel(attempt: KingAttempt | undefined): string | undefined {
  if (!attempt) return undefined;
  return (
    workflow?.tasks.find((task: KingTask) => task.id === attempt.taskId)?.title ?? `King ${attempt.id.slice(0, 8)}`
  );
}

function taskLabel(terminal: WorkspaceTerminal): string {
  return terminal.kingAttemptId ? `King ${terminal.kingAttemptId.slice(0, 8)}` : terminal.name;
}

function taskState(terminal: WorkspaceTerminal): string {
  if (terminal.state === 'exited') return 'exited';
  return terminal.foregroundProcess?.label ?? 'starting';
}

async function refresh() {
  try {
    workflow = await requestJson<WorkflowResponse>('/api/king/workflow', undefined, 'Loading workspace agents', {
      timeoutMs: KING_REFRESH_TIMEOUT_MS,
    });
  } catch {
    // Terminal metadata remains enough to expose a dedicated King agent while
    // a transient workflow refresh is retried.
  }
}

async function stopTask(attemptId: string | undefined) {
  if (!attemptId) return;
  stoppingAttemptId = attemptId;
  errorMessage = '';
  try {
    await requestJson(
      '/api/king/workflow',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'cancel',
          attemptId,
          reason: `Owner stopped King Attempt ${attemptId} from its workspace agent bar.`,
        }),
      },
      'Stopping the King agent',
      { timeoutMs: KING_ACTION_TIMEOUT_MS }
    );
    onSelect(mainTerminal?.id);
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : 'Unable to stop the King agent.';
  } finally {
    stoppingAttemptId = undefined;
  }
}

onMount(() => {
  void refresh();
  const timer = window.setInterval(() => void refresh(), 2_000);
  return () => window.clearInterval(timer);
});
</script>

{#if visible}
  {@const mainAttempt = attemptForTerminal(mainTerminal)}
  <div class="workspace-agents">
    <nav class="workspace-agent-tabs" aria-label="Workspace agents">
      <button
        type="button"
        class:active={selectedTerminalId === mainTerminal?.id}
        aria-current={selectedTerminalId === mainTerminal?.id ? 'page' : undefined}
        onclick={() => onSelect(mainTerminal?.id)}
      >
        <SquareTerminal size={14} strokeWidth={1.8} aria-hidden="true" />
        <span>Main</span>
        {#if mainAttempt}
          <Crown size={12} strokeWidth={1.9} aria-hidden="true" />
          <small>{attemptLabel(mainAttempt)} · {mainAttempt.status}</small>
        {/if}
      </button>
      {#each taskTerminals as terminal (terminal.id)}
        {@const attempt = attemptForTerminal(terminal)}
        <button
          type="button"
          class="king-agent-tab"
          class:active={selectedTerminalId === terminal.id}
          aria-current={selectedTerminalId === terminal.id ? 'page' : undefined}
          onclick={() => onSelect(terminal.id)}
        >
          <Crown size={14} strokeWidth={1.9} aria-hidden="true" />
          <span>{attemptLabel(attempt) ?? taskLabel(terminal)}</span>
          <small>{attempt?.status ?? taskState(terminal)}</small>
        </button>
      {/each}
    </nav>
    {#if selectedAttemptId}
      <Button
        size="sm"
        variant="danger-outline"
        disabled={stoppingAttemptId === selectedAttemptId}
        ariaLabel={`Stop ${attemptLabel(selectedAttempt) ?? (selectedTask ? taskLabel(selectedTask) : `King ${selectedAttemptId.slice(0, 8)}`)}`}
        onclick={() => void stopTask(selectedAttemptId)}
      >
        <CircleStop size={14} strokeWidth={1.8} aria-hidden="true" />
        Stop
      </Button>
    {/if}
  </div>
  {#if errorMessage}
    <p class="workspace-agent-error" role="alert">{errorMessage}</p>
  {/if}
{/if}

<style>
.workspace-agents {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 0.5rem;
  padding: 0.35rem 0.75rem;
  border-top: 1px solid var(--color-border-subtle);
  border-bottom: 1px solid var(--color-border);
  background: var(--color-panel);
}
.workspace-agent-tabs {
  display: flex;
  min-width: 0;
  flex: 1;
  gap: 0.3rem;
  overflow-x: auto;
  scrollbar-width: none;
}
.workspace-agent-tabs::-webkit-scrollbar {
  display: none;
}
.workspace-agent-tabs button {
  display: inline-flex;
  align-items: center;
  min-height: 1.8rem;
  flex: 0 0 auto;
  gap: 0.3rem;
  padding: 0.2rem 0.5rem;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
  font: inherit;
  font-size: var(--text-caption);
}
.workspace-agent-tabs button.active {
  border-color: var(--color-border);
  background: var(--color-surface-raised);
  color: var(--color-text);
}
.workspace-agent-tabs .king-agent-tab {
  color: var(--color-warning-text-secondary);
}
.workspace-agent-tabs .king-agent-tab.active {
  border-color: var(--color-warning-border);
  background: var(--color-warning-surface);
  color: var(--color-warning-text);
}
.workspace-agent-tabs small {
  color: var(--color-text-tertiary);
  font-size: var(--text-nano);
}
.workspace-agent-error {
  margin: 0;
  padding: 0.3rem 0.75rem;
  border-bottom: 1px solid var(--color-danger-border);
  background: var(--color-danger-surface);
  color: var(--color-danger-text);
  font-size: var(--text-caption);
}
</style>
