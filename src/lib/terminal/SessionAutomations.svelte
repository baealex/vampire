<script lang="ts">
import { onDestroy, onMount, untrack } from 'svelte';
import Clock3 from '@lucide/svelte/icons/clock-3';
import Pause from '@lucide/svelte/icons/pause';
import Play from '@lucide/svelte/icons/play';
import Plus from '@lucide/svelte/icons/plus';
import Trash2 from '@lucide/svelte/icons/trash-2';
import X from '@lucide/svelte/icons/x';
import { queryCache, type QuerySnapshot } from '$lib/client/query-cache';
import { requestJson } from '$lib/client/request';
import {
  MAX_AUTOMATION_INTERVAL_MS,
  MIN_AUTOMATION_INTERVAL_MS,
  SESSION_AUTOMATION_NAME_MAX_LENGTH,
  SESSION_AUTOMATION_PROMPT_MAX_LENGTH,
  type SessionAutomation,
  type SessionAutomationSchedule,
} from '$lib/session/automations';

const REFRESH_INTERVAL_MS = 5_000;

let {
  sessionId,
  close,
  embedded = false,
}: {
  sessionId: string;
  close: () => void;
  embedded?: boolean;
} = $props();

type SessionAutomationsResponse = { automations: SessionAutomation[] };
const automationsQuery = untrack(() => `session/${sessionId}/automations`);
const initialResponse = queryCache.get<SessionAutomationsResponse>(automationsQuery);
let automations = $state<SessionAutomation[]>(initialResponse?.automations ?? []);
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

function scheduleInput(): SessionAutomationSchedule | undefined {
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

function applyQuerySnapshot(snapshot: QuerySnapshot<SessionAutomationsResponse>) {
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
        requestJson<SessionAutomationsResponse>(
          `/api/sessions/${encodeURIComponent(sessionId)}/automations`,
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
    const data = await requestJson<{ automation: SessionAutomation }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/automations`,
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

async function setEnabled(automation: SessionAutomation, enabled: boolean) {
  if (updatingId) return;
  updatingId = automation.id;
  mutationError = '';
  try {
    const data = await requestJson<{ automation: SessionAutomation }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/automations/${encodeURIComponent(automation.id)}`,
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

async function deleteAutomation(automation: SessionAutomation) {
  if (updatingId) return;
  updatingId = automation.id;
  mutationError = '';
  try {
    await requestJson<{ ok: boolean }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/automations/${encodeURIComponent(automation.id)}`,
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

function scheduleLabel(automation: SessionAutomation): string {
  return automation.schedule.type === 'interval'
    ? `Every ${formatInterval(automation.schedule.intervalMs)}`
    : 'One time';
}

function statusLabel(automation: SessionAutomation): string {
  if (automation.lastOutcome === 'failed') return 'Delivery failed';
  if (automation.lastOutcome === 'uncertain') return 'Delivery uncertain';
  if (!automation.enabled) {
    return automation.schedule.type === 'once' && automation.lastOutcome === 'submitted' ? 'Sent' : 'Paused';
  }
  if (automation.nextRunAt !== null && automation.nextRunAt <= now) return 'Waiting for agent';
  return automation.nextRunAt === null ? 'Paused' : `Next ${formatTimestamp(automation.nextRunAt)}`;
}

function resumeLabel(automation: SessionAutomation): string {
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

<div
  class:embedded
  class="automation-panel"
  role={embedded ? undefined : 'dialog'}
  aria-busy={fetching}
  aria-labelledby={embedded ? undefined : 'automation-panel-title'}
>
  {#if !embedded}
    <header>
      <div>
        <h2 id="automation-panel-title">Agent automations</h2>
        <p>Prompts wait until the recognized main agent is ready for input.</p>
      </div>
      <button type="button" class="close-button" onclick={close} aria-label="Close agent automations">
        <X size={17} strokeWidth={1.9} aria-hidden="true" />
      </button>
    </header>
  {:else}
    <p class="automation-description">Prompts wait until the recognized main agent is ready for input.</p>
  {/if}

  <form onsubmit={(event) => { event.preventDefault(); void createAutomation(); }}>
    <label>
      <span>Name</span>
      <input
        bind:value={name}
        maxlength={SESSION_AUTOMATION_NAME_MAX_LENGTH}
        placeholder="Daily project check"
        required
      >
    </label>
    <label>
      <span>Prompt</span>
      <textarea
        bind:value={prompt}
        maxlength={SESSION_AUTOMATION_PROMPT_MAX_LENGTH}
        rows="4"
        placeholder="Review the current work and take the next useful step…"
        required
      ></textarea>
    </label>
    <div class="schedule-row">
      <label>
        <span>Schedule</span>
        <select bind:value={scheduleType}>
          <option value="once">One time</option>
          <option value="interval">Repeat</option>
        </select>
      </label>
      <label>
        <span>{scheduleType === 'once' ? 'Run at' : 'First run'}</span>
        <input type="datetime-local" bind:value={runAt} required>
      </label>
    </div>
    {#if scheduleType === 'interval'}
      <div class="interval-row">
        <label>
          <span>Repeat every</span>
          <input type="number" bind:value={intervalValue} min="1" step="1" required>
        </label>
        <label>
          <span>Unit</span>
          <select bind:value={intervalUnit}>
            <option value="minutes">Minutes</option>
            <option value="hours">Hours</option>
            <option value="days">Days</option>
          </select>
        </label>
      </div>
    {/if}
    <button class="create-button" type="submit" disabled={creating}>
      <Plus size={16} strokeWidth={1.9} aria-hidden="true" />
      {creating ? 'Saving…' : 'Add automation'}
    </button>
  </form>

  {#if mutationError}
    <p class="automation-error" role="alert">{mutationError}</p>
  {/if}

  <div class="automation-list" aria-live="polite">
    {#if loading}
      <p class="automation-empty">Loading automations…</p>
    {:else if loadError}
      <div class="automation-empty">
        <p role="alert">{loadError}</p>
        <button type="button" onclick={() => void loadAutomations(false, true)}>Retry</button>
      </div>
    {:else if automations.length === 0}
      <p class="automation-empty">No automations yet.</p>
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
            <button
              type="button"
              disabled={Boolean(updatingId)}
              onclick={() => void setEnabled(automation, !automation.enabled)}
            >
              {#if automation.enabled}
                <Pause size={14} strokeWidth={1.9} aria-hidden="true" />
                Pause
              {:else}
                <Play size={14} strokeWidth={1.9} aria-hidden="true" /> {resumeLabel(automation)}
              {/if}
            </button>
            <button
              type="button"
              class="delete-button"
              disabled={Boolean(updatingId)}
              onclick={() => void deleteAutomation(automation)}
            >
              <Trash2 size={14} strokeWidth={1.9} aria-hidden="true" />
              Delete
            </button>
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
  max-height: min(46rem, calc(100dvh - 5rem));
  box-sizing: border-box;
  overflow-y: auto;
  padding: 1rem;
  border: 1px solid var(--color-border-strong);
  border-radius: 0.8rem;
  background: var(--color-surface-overlay);
  box-shadow: var(--shadow-popover);
}
.automation-panel.embedded {
  max-height: none;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}
.automation-description {
  margin: 0;
  color: var(--color-text-secondary);
  font-size: var(--text-caption);
  line-height: var(--leading-ui);
}
header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
}
h2 {
  margin: 0;
  font-size: var(--text-title);
  font-weight: var(--weight-strong);
  line-height: var(--leading-tight);
}
header p {
  margin: 0.25rem 0 0;
  color: var(--color-text-tertiary);
  font-size: var(--text-caption);
  line-height: var(--leading-ui);
}
.close-button {
  display: grid;
  flex: 0 0 auto;
  place-items: center;
  width: 2rem;
  height: 2rem;
  padding: 0;
  border: 0;
  border-radius: 0.42rem;
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
}
.close-button:hover {
  background: var(--color-control-hover);
  color: var(--color-text);
}
form {
  display: grid;
  gap: 0.7rem;
  padding: 0.8rem;
  border: 1px solid var(--color-border);
  border-radius: 0.65rem;
  background: var(--color-surface);
}
label {
  display: grid;
  gap: 0.32rem;
  min-width: 0;
  color: var(--color-text-secondary);
  font-size: var(--text-caption);
  font-weight: var(--weight-medium);
}
input,
textarea,
select {
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  padding: 0.6rem 0.65rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  outline: none;
  background: var(--color-control-background);
  color: var(--color-text);
  font: inherit;
  font-size: var(--text-label);
}
textarea {
  resize: vertical;
  line-height: var(--leading-body);
}
input:focus,
textarea:focus,
select:focus {
  border-color: var(--color-accent);
  box-shadow: var(--shadow-accent-focus);
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
.create-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  min-height: 2.45rem;
  padding: 0 0.8rem;
  border: 0;
  border-radius: var(--radius-control);
  background: var(--color-accent);
  color: var(--color-accent-ink);
  font: inherit;
  font-size: var(--text-label);
  font-weight: var(--weight-medium);
  cursor: pointer;
}
.create-button:hover:not(:disabled) {
  background: var(--color-accent-hover);
}
.create-button:disabled {
  cursor: wait;
  opacity: 0.65;
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
  border-radius: 0.65rem;
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
.automation-actions button,
.automation-empty button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.32rem;
  min-height: 2.15rem;
  padding: 0 0.65rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-secondary);
  font: inherit;
  font-size: var(--text-caption);
  cursor: pointer;
}
.automation-actions button:hover:not(:disabled),
.automation-empty button:hover {
  background: var(--color-control-hover);
  color: var(--color-text);
}
.automation-actions .delete-button {
  color: var(--color-danger-text);
}
.automation-actions button:disabled {
  cursor: wait;
  opacity: 0.55;
}
.automation-empty {
  margin: 0;
  padding: 1rem;
  border: 1px dashed var(--color-border);
  border-radius: 0.65rem;
  color: var(--color-text-tertiary);
  font-size: var(--text-label);
  text-align: center;
}
.automation-empty p {
  margin: 0 0 0.65rem;
}

@media (max-width: 32rem) {
  .automation-panel {
    max-height: calc(100dvh - 4rem);
    padding: 0.85rem;
  }
  .schedule-row,
  .interval-row {
    grid-template-columns: 1fr;
  }
  input,
  textarea,
  select {
    font-size: 1rem;
  }
}
</style>
