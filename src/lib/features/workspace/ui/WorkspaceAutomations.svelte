<script lang="ts">
import { onDestroy, onMount, untrack } from 'svelte';
import Clock3 from '@lucide/svelte/icons/clock-3';
import Pause from '@lucide/svelte/icons/pause';
import Play from '@lucide/svelte/icons/play';
import Plus from '@lucide/svelte/icons/plus';
import Trash2 from '@lucide/svelte/icons/trash-2';
import { queryCache, type QuerySnapshot } from '~/lib/shared/api/query-cache';
import { requestJson } from '~/lib/shared/api/request';
import {
  MAX_AUTOMATION_INTERVAL_MS,
  MIN_AUTOMATION_INTERVAL_MS,
  WORKSPACE_AUTOMATION_NAME_MAX_LENGTH,
  WORKSPACE_AUTOMATION_PROMPT_MAX_LENGTH,
  type WorkspaceAutomation,
  type WorkspaceAutomationSchedule,
} from '~/lib/shared/contracts/workspace-automations';
import Button from '~/lib/shared/ui/Button.svelte';
import DialogEmptyState from '~/lib/shared/ui/DialogEmptyState.svelte';
import Field from '~/lib/shared/ui/Field.svelte';
import Input from '~/lib/shared/ui/Input.svelte';
import Select from '~/lib/shared/ui/Select.svelte';
import Textarea from '~/lib/shared/ui/Textarea.svelte';

const REFRESH_INTERVAL_MS = 5_000;

let { workspaceId }: { workspaceId: string } = $props();

type WorkspaceAutomationsResponse = { automations: WorkspaceAutomation[] };
const automationsQuery = untrack(() => `workspace/${workspaceId}/automations`);
const initialResponse = queryCache.get<WorkspaceAutomationsResponse>(automationsQuery);
let automations = $state<WorkspaceAutomation[]>(initialResponse?.automations ?? []);
let hasData = $state(initialResponse !== undefined);
let loading = $state(initialResponse === undefined);
let fetching = $state(false);
let refreshing = false;
let loadError = $state('');
let mutationError = $state('');
let creating = $state(false);
let updatingId = $state<string>();
let name = $state('');
let prompt = $state('');
let scheduleType = $state<'once' | 'interval'>('once');
let runAt = $state('');
let intervalValue = $state(60);
let intervalUnit = $state<'minutes' | 'hours' | 'days'>('minutes');
let now = $state(Date.now());
let refreshTimer: ReturnType<typeof setInterval> | undefined;

function localDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(timestamp - offset).toISOString().slice(0, 16);
}

function resetRunAt() {
  runAt = localDateTime(Date.now() + 5 * 60_000);
}

function intervalMilliseconds(): number {
  const multiplier = intervalUnit === 'days' ? 24 * 60 * 60_000 : intervalUnit === 'hours' ? 60 * 60_000 : 60_000;
  return intervalValue * multiplier;
}

function scheduleInput(): WorkspaceAutomationSchedule | undefined {
  const timestamp = new Date(runAt).getTime();
  if (!Number.isFinite(timestamp)) return undefined;
  if (scheduleType === 'once') return { type: 'once', runAt: timestamp };
  const intervalMs = intervalMilliseconds();
  if (
    !Number.isFinite(intervalMs) ||
    intervalMs < MIN_AUTOMATION_INTERVAL_MS ||
    intervalMs > MAX_AUTOMATION_INTERVAL_MS
  )
    return undefined;
  return { type: 'interval', intervalMs, startAt: timestamp };
}

function applyQuerySnapshot(snapshot: QuerySnapshot<WorkspaceAutomationsResponse>) {
  hasData = snapshot.data !== undefined;
  fetching = snapshot.isFetching;
  loading = !hasData && snapshot.isFetching;
  if (snapshot.data) automations = snapshot.data.automations;
  if (snapshot.error && !hasData) {
    loadError = snapshot.error instanceof Error ? snapshot.error.message : 'Unable to load automations';
  } else if (!snapshot.error) {
    loadError = '';
  }
}

async function loadAutomations(quiet = false, force = true) {
  if (refreshing) return;
  refreshing = true;
  if (!quiet) loadError = '';
  try {
    await queryCache.fetch(
      automationsQuery,
      () =>
        requestJson<WorkspaceAutomationsResponse>(
          `/api/workspaces/${encodeURIComponent(workspaceId)}/automations`,
          { cache: 'no-store' },
          'Unable to load automations'
        ),
      force
    );
  } catch (error) {
    if (!quiet && !hasData) loadError = error instanceof Error ? error.message : 'Unable to load automations';
  } finally {
    refreshing = false;
  }
}

async function createAutomation() {
  if (creating) return;
  const schedule = scheduleInput();
  if (!name.trim() || !prompt.trim() || !schedule) {
    mutationError = 'Enter a name, prompt, and valid schedule.';
    return;
  }
  creating = true;
  mutationError = '';
  try {
    const data = await requestJson<{ automation: WorkspaceAutomation }>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/automations`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, prompt, schedule }),
      },
      'Unable to save the automation'
    );
    automations = [data.automation, ...automations.filter((item) => item.id !== data.automation.id)];
    queryCache.set(automationsQuery, { automations });
    name = '';
    prompt = '';
    resetRunAt();
  } catch (error) {
    mutationError = error instanceof Error ? error.message : 'Unable to save the automation';
  } finally {
    creating = false;
  }
}

async function setEnabled(automation: WorkspaceAutomation, enabled: boolean) {
  if (updatingId) return;
  updatingId = automation.id;
  mutationError = '';
  try {
    const data = await requestJson<{ automation: WorkspaceAutomation }>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/automations/${encodeURIComponent(automation.id)}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled }),
      },
      'Unable to update the automation'
    );
    automations = automations.map((item) => (item.id === data.automation.id ? data.automation : item));
    queryCache.set(automationsQuery, { automations });
  } catch (error) {
    mutationError = error instanceof Error ? error.message : 'Unable to update the automation';
  } finally {
    updatingId = undefined;
  }
}

async function deleteAutomation(automation: WorkspaceAutomation) {
  if (updatingId) return;
  updatingId = automation.id;
  mutationError = '';
  try {
    await requestJson<{ ok: boolean }>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/automations/${encodeURIComponent(automation.id)}`,
      { method: 'DELETE' },
      'Unable to delete the automation'
    );
    automations = automations.filter((item) => item.id !== automation.id);
    queryCache.set(automationsQuery, { automations });
  } catch (error) {
    mutationError = error instanceof Error ? error.message : 'Unable to delete the automation';
  } finally {
    updatingId = undefined;
  }
}

function formatTimestamp(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(timestamp);
}

function formatInterval(intervalMs: number): string {
  if (intervalMs % (24 * 60 * 60_000) === 0) return `${intervalMs / (24 * 60 * 60_000)}d`;
  if (intervalMs % (60 * 60_000) === 0) return `${intervalMs / (60 * 60_000)}h`;
  return `${intervalMs / 60_000}m`;
}

function scheduleLabel(automation: WorkspaceAutomation): string {
  return automation.schedule.type === 'interval'
    ? `Every ${formatInterval(automation.schedule.intervalMs)}`
    : 'One time';
}

function statusLabel(automation: WorkspaceAutomation): string {
  if (automation.lastOutcome === 'failed') return 'Delivery failed';
  if (automation.lastOutcome === 'uncertain') return 'Delivery uncertain';
  if (!automation.enabled) {
    return automation.schedule.type === 'once' && automation.lastOutcome === 'submitted' ? 'Sent' : 'Paused';
  }
  if (automation.nextRunAt !== null && automation.nextRunAt <= now) return 'Waiting for agent';
  return automation.nextRunAt === null ? 'Paused' : `Next ${formatTimestamp(automation.nextRunAt)}`;
}

function resumeLabel(automation: WorkspaceAutomation): string {
  return automation.schedule.type === 'once' && automation.lastAttemptAt !== null ? 'Run again' : 'Resume';
}

let unsubscribe: (() => void) | undefined;

onMount(() => {
  resetRunAt();
  unsubscribe = queryCache.subscribe(automationsQuery, applyQuerySnapshot);
  void loadAutomations(false, true);
  refreshTimer = setInterval(() => {
    now = Date.now();
    void loadAutomations(true, true);
  }, REFRESH_INTERVAL_MS);
});

onDestroy(() => {
  if (refreshTimer !== undefined) clearInterval(refreshTimer);
  unsubscribe?.();
});
</script>

<div class="automation-panel" aria-busy={fetching}>
  <p class="automation-description">Prompts wait until the recognized main agent is ready for input.</p>

  <form onsubmit={(event) => { event.preventDefault(); void createAutomation(); }}>
    <Field label="Name">
      <Input
        bind:value={name}
        maxlength={WORKSPACE_AUTOMATION_NAME_MAX_LENGTH}
        placeholder="Daily project check"
        required
      />
    </Field>
    <Field label="Prompt">
      <Textarea
        bind:value={prompt}
        maxlength={WORKSPACE_AUTOMATION_PROMPT_MAX_LENGTH}
        rows={4}
        placeholder="Review the current work and take the next useful step…"
        required
      />
    </Field>
    <div class="schedule-row">
      <Field label="Schedule">
        <Select
          value={scheduleType}
          onchange={(event) => scheduleType = (event.currentTarget as HTMLSelectElement).value as 'once' | 'interval'}
        >
          <option value="once">One time</option>
          <option value="interval">Repeat</option>
        </Select>
      </Field>
      <Field label={scheduleType === 'once' ? 'Run at' : 'First run'}>
        <Input type="datetime-local" bind:value={runAt} required />
      </Field>
    </div>
    {#if scheduleType === 'interval'}
      <div class="interval-row">
        <Field label="Repeat every">
          <Input
            type="number"
            value={String(intervalValue)}
            min={1}
            step={1}
            required
            oninput={(event) => intervalValue = (event.currentTarget as HTMLInputElement).valueAsNumber}
          />
        </Field>
        <Field label="Unit">
          <Select
            value={intervalUnit}
            onchange={(event) => intervalUnit = (event.currentTarget as HTMLSelectElement).value as typeof intervalUnit}
          >
            <option value="minutes">Minutes</option>
            <option value="hours">Hours</option>
            <option value="days">Days</option>
          </Select>
        </Field>
      </div>
    {/if}
    <Button variant="primary" class="create-button" type="submit" disabled={creating}>
      <Plus size={16} strokeWidth={1.9} aria-hidden="true" />
      {creating ? 'Saving…' : 'Add automation'}
    </Button>
  </form>

  {#if mutationError}
    <p class="automation-error" role="alert">{mutationError}</p>
  {/if}

  <div class="automation-list" aria-live="polite">
    {#if loading}
      <DialogEmptyState>Loading automations…</DialogEmptyState>
    {:else if loadError}
      <DialogEmptyState as="div" class="automation-empty">
        <p role="alert">{loadError}</p>
        <Button size="sm" onclick={() => void loadAutomations(false, true)}>Retry</Button>
      </DialogEmptyState>
    {:else if automations.length === 0}
      <DialogEmptyState>No automations yet.</DialogEmptyState>
    {:else}
      {#each automations as automation (automation.id)}
        <article class:paused={!automation.enabled}>
          <div class="automation-heading">
            <div>
              <strong>{automation.name}</strong>
              <span>{scheduleLabel(automation)} · {statusLabel(automation)}</span>
            </div>
            <Clock3 size={16} strokeWidth={1.8} aria-hidden="true" />
          </div>
          <p class="automation-prompt">{automation.prompt}</p>
          {#if automation.lastRunAt}
            <p class="automation-meta">Last sent {formatTimestamp(automation.lastRunAt)}</p>
          {/if}
          {#if automation.lastError}
            <p class="automation-error" role="alert">{automation.lastError}</p>
          {/if}
          <div class="automation-actions">
            <Button
              size="sm"
              disabled={Boolean(updatingId)}
              onclick={() => void setEnabled(automation, !automation.enabled)}
            >
              {#if automation.enabled}
                <Pause size={14} strokeWidth={1.9} aria-hidden="true" />
                Pause
              {:else}
                <Play size={14} strokeWidth={1.9} aria-hidden="true" /> {resumeLabel(automation)}
              {/if}
            </Button>
            <Button
              variant="danger-outline"
              size="sm"
              disabled={Boolean(updatingId)}
              onclick={() => void deleteAutomation(automation)}
            >
              <Trash2 size={14} strokeWidth={1.9} aria-hidden="true" />
              Delete
            </Button>
          </div>
        </article>
      {/each}
    {/if}
  </div>
</div>

<style>
.automation-panel {
  display: grid;
  gap: 1rem;
  width: 100%;
  box-sizing: border-box;
}
.automation-description {
  margin: 0;
  color: var(--color-text-secondary);
  font-size: var(--text-caption);
  line-height: var(--leading-ui);
}
form {
  display: grid;
  gap: 0.7rem;
}
.schedule-row,
.interval-row {
  display: grid;
  grid-template-columns: minmax(0, 0.72fr) minmax(0, 1.28fr);
  gap: 0.65rem;
}
.interval-row {
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
}
:global(.create-button) {
  justify-self: end;
}
.automation-list {
  display: grid;
  gap: 0.65rem;
}
.automation-list article {
  display: grid;
  gap: 0.55rem;
  padding: 0.75rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-control-background);
}
.automation-list article.paused {
  opacity: 0.72;
}
.automation-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
}
.automation-heading > div {
  display: grid;
  gap: 0.15rem;
  min-width: 0;
}
.automation-heading strong {
  overflow: hidden;
  color: var(--color-text);
  font-size: var(--text-label);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.automation-heading span,
.automation-meta {
  color: var(--color-text-tertiary);
  font-size: var(--text-caption);
  line-height: var(--leading-ui);
}
.automation-heading :global(svg) {
  flex: 0 0 auto;
  color: var(--color-command);
}
.automation-prompt {
  display: -webkit-box;
  margin: 0;
  overflow: hidden;
  color: var(--color-text-secondary);
  font-size: var(--text-label);
  line-height: var(--leading-body);
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  line-clamp: 3;
}
.automation-meta,
.automation-error {
  margin: 0;
}
.automation-error {
  color: var(--color-danger-text);
  font-size: var(--text-caption);
  line-height: var(--leading-ui);
}
.automation-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.45rem;
}
:global(.automation-empty) {
  gap: 0.65rem;
}
:global(.automation-empty p) {
  margin: 0;
}

@media (max-width: 32rem) {
  .schedule-row,
  .interval-row {
    grid-template-columns: 1fr;
  }
}
</style>
