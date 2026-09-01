<script lang="ts">
import Clock3 from '@lucide/svelte/icons/clock-3';
import Pause from '@lucide/svelte/icons/pause';
import Pencil from '@lucide/svelte/icons/pencil';
import Play from '@lucide/svelte/icons/play';
import RefreshCw from '@lucide/svelte/icons/refresh-cw';
import Settings2 from '@lucide/svelte/icons/settings-2';
import Trash2 from '@lucide/svelte/icons/trash-2';
import { onDestroy, onMount } from 'svelte';
import { queryCache, type QuerySnapshot } from '~/lib/shared/api/query-cache.ts';
import { requestJson } from '~/lib/shared/api/request.ts';
import type { WorkspaceAutomation, WorkspaceAutomationGroup } from '~/lib/shared/contracts/workspace-automations.ts';
import type { ManagedWorkspace } from '~/lib/shared/contracts/workspace.ts';
import Button from '~/lib/shared/ui/Button.svelte';
import DialogEmptyState from '~/lib/shared/ui/DialogEmptyState.svelte';
import { workspaceName } from '../model/workspace-view.ts';

const AUTOMATIONS_QUERY = 'server/automations';
const REFRESH_INTERVAL_MS = 5_000;
type AutomationsResponse = { groups: WorkspaceAutomationGroup[] };

let {
  workspaces,
  onManage,
  onBusyChange = () => undefined,
}: {
  workspaces: ManagedWorkspace[];
  onManage: (workspace: ManagedWorkspace, automationId?: string) => void;
  onBusyChange?: (busy: boolean) => void;
} = $props();

const initialResponse = queryCache.get<AutomationsResponse>(AUTOMATIONS_QUERY);
let groups = $state<WorkspaceAutomationGroup[]>(initialResponse?.groups ?? []);
let hasData = $state(initialResponse !== undefined);
let loading = $state(initialResponse === undefined);
let fetching = $state(false);
let refreshing = false;
let loadError = $state('');
let mutationError = $state('');
let updatingKey = $state<string>();
let now = $state(Date.now());
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let unsubscribe: (() => void) | undefined;

const orderedGroups = $derived(
  [...groups].sort((left, right) => {
    const leftIndex = workspaces.findIndex((workspace) => workspace.id === left.workspaceId);
    const rightIndex = workspaces.findIndex((workspace) => workspace.id === right.workspaceId);
    return (
      (leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex) - (rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex)
    );
  })
);
const automationCount = $derived(orderedGroups.reduce((count, group) => count + group.automations.length, 0));
const activeCount = $derived(
  orderedGroups.reduce((count, group) => count + group.automations.filter((automation) => automation.enabled).length, 0)
);
const configuredWorkspaceCount = $derived(orderedGroups.filter((group) => group.automations.length > 0).length);
const busy = $derived(Boolean(updatingKey));

$effect(() => onBusyChange(busy));

function groupKey(workspaceId: string, automationId: string): string {
  return `${workspaceId}/${automationId}`;
}

function workspaceFor(workspaceId: string): ManagedWorkspace | undefined {
  return workspaces.find((workspace) => workspace.id === workspaceId);
}

function applyQuerySnapshot(snapshot: QuerySnapshot<AutomationsResponse>) {
  hasData = snapshot.data !== undefined;
  fetching = snapshot.isFetching;
  loading = !hasData && snapshot.isFetching;
  if (snapshot.data) groups = snapshot.data.groups;
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
      AUTOMATIONS_QUERY,
      () => requestJson<AutomationsResponse>('/api/automations', { cache: 'no-store' }, 'Unable to load automations'),
      force
    );
  } catch (error) {
    if (!quiet && !hasData) loadError = error instanceof Error ? error.message : 'Unable to load automations';
  } finally {
    refreshing = false;
  }
}

function replaceGroup(workspaceId: string, automations: WorkspaceAutomation[]) {
  groups = groups.map((group) => (group.workspaceId === workspaceId ? { ...group, automations } : group));
  queryCache.set(AUTOMATIONS_QUERY, { groups });
  queryCache.set(`workspace/${workspaceId}/automations`, { automations });
}

async function setEnabled(group: WorkspaceAutomationGroup, automation: WorkspaceAutomation, enabled: boolean) {
  if (updatingKey) return;
  updatingKey = groupKey(group.workspaceId, automation.id);
  mutationError = '';
  try {
    const data = await requestJson<{ automation: WorkspaceAutomation }>(
      `/api/workspaces/${encodeURIComponent(group.workspaceId)}/automations/${encodeURIComponent(automation.id)}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled }),
      },
      'Unable to update the automation'
    );
    replaceGroup(
      group.workspaceId,
      group.automations.map((candidate) => (candidate.id === data.automation.id ? data.automation : candidate))
    );
  } catch (error) {
    mutationError = error instanceof Error ? error.message : 'Unable to update the automation';
  } finally {
    updatingKey = undefined;
  }
}

async function deleteAutomation(group: WorkspaceAutomationGroup, automation: WorkspaceAutomation) {
  if (updatingKey) return;
  updatingKey = groupKey(group.workspaceId, automation.id);
  mutationError = '';
  try {
    await requestJson<{ ok: boolean }>(
      `/api/workspaces/${encodeURIComponent(group.workspaceId)}/automations/${encodeURIComponent(automation.id)}`,
      { method: 'DELETE' },
      'Unable to delete the automation'
    );
    replaceGroup(
      group.workspaceId,
      group.automations.filter((candidate) => candidate.id !== automation.id)
    );
  } catch (error) {
    mutationError = error instanceof Error ? error.message : 'Unable to delete the automation';
  } finally {
    updatingKey = undefined;
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
  if (intervalMs % 60_000 === 0) return `${intervalMs / 60_000}m`;
  if (intervalMs % 1_000 === 0) return `${intervalMs / 1_000}s`;
  return `${intervalMs}ms`;
}

function scheduleLabel(automation: WorkspaceAutomation): string {
  if (automation.schedule.type === 'once') return 'One time';
  if (automation.schedule.type === 'interval') return `Every ${formatInterval(automation.schedule.intervalMs)}`;
  const labels = automation.schedule.weekdays.map((weekday) =>
    new Intl.DateTimeFormat(undefined, { weekday: 'short', timeZone: 'UTC' }).format(Date.UTC(2026, 7, 30 + weekday))
  );
  const time = new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: automation.schedule.timeZone,
  }).format(automation.nextRunAt ?? automation.schedule.startAt);
  return `${labels.join(', ')} at ${time}`;
}

function statusLabel(automation: WorkspaceAutomation): string {
  if (automation.lastOutcome === 'failed') return 'Delivery failed';
  if (automation.lastOutcome === 'uncertain') return 'Delivery uncertain';
  if (!automation.enabled) {
    return automation.schedule.type === 'once' && automation.lastOutcome === 'submitted' ? 'Sent' : 'Paused';
  }
  if (automation.nextRunAt !== null && automation.nextRunAt <= now) return 'Pending delivery';
  return automation.nextRunAt === null ? 'Paused' : `Next ${formatTimestamp(automation.nextRunAt)}`;
}

function resumeLabel(automation: WorkspaceAutomation): string {
  return automation.schedule.type === 'once' && automation.lastAttemptAt !== null ? 'Run again' : 'Resume';
}

onMount(() => {
  unsubscribe = queryCache.subscribe(AUTOMATIONS_QUERY, applyQuerySnapshot);
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

<div class="overview" aria-busy={fetching || busy}>
  <header class="overview-toolbar">
    <div>
      <strong>{automationCount} {automationCount === 1 ? 'automation' : 'automations'}</strong>
      <p>
        {activeCount}
        active · {configuredWorkspaceCount} of {orderedGroups.length}
        {orderedGroups.length === 1 ? 'workspace' : 'workspaces'}
        configured.
      </p>
    </div>
    <Button
      variant="secondary"
      size="sm"
      ariaLabel="Refresh all automations"
      disabled={busy}
      onclick={() => void loadAutomations(false, true)}
    >
      <RefreshCw size={15} strokeWidth={1.8} aria-hidden="true" />
      Refresh
    </Button>
  </header>

  {#if mutationError}
    <p class="automation-error" role="alert">{mutationError}</p>
  {/if}

  <div class="workspace-groups" aria-live="polite">
    {#if loading}
      <DialogEmptyState>Loading automations…</DialogEmptyState>
    {:else if loadError}
      <DialogEmptyState as="div" class="automation-empty">
        <p role="alert">{loadError}</p>
        <Button size="sm" onclick={() => void loadAutomations(false, true)}>Retry</Button>
      </DialogEmptyState>
    {:else if orderedGroups.length === 0}
      <DialogEmptyState>No workspaces are registered on this server.</DialogEmptyState>
    {:else}
      {#each orderedGroups as group, groupIndex (group.workspaceId)}
        {@const workspace = workspaceFor(group.workspaceId)}
        <section class="workspace-group" aria-labelledby={`automation-workspace-${groupIndex}`}>
          <header class="workspace-heading">
            <div>
              <h2 id={`automation-workspace-${groupIndex}`}>
                {workspace ? workspaceName(workspace) : group.workspaceId}
              </h2>
              <p>
                {group.automations.length} {group.automations.length === 1 ? 'automation' : 'automations'}
                {workspace?.state === 'missing' ? ' · Workspace unavailable' : ''}
              </p>
            </div>
            {#if workspace}
              <Button
                size="sm"
                ariaLabel={`Manage automations for ${workspaceName(workspace)}`}
                onclick={() => onManage(workspace)}
              >
                <Settings2 size={14} strokeWidth={1.8} aria-hidden="true" />
                Manage
              </Button>
            {/if}
          </header>

          {#if group.automations.length === 0}
            <p class="workspace-empty">No automations yet. Open this workspace to create one.</p>
          {:else}
            <div class="automation-list">
              {#each group.automations as automation (automation.id)}
                <article class:paused={!automation.enabled}>
                  <div class="automation-copy">
                    <div class="automation-heading">
                      <Clock3 size={16} strokeWidth={1.8} aria-hidden="true" />
                      <div>
                        <strong>{automation.name}</strong>
                        <span>{scheduleLabel(automation)} · {statusLabel(automation)}</span>
                      </div>
                    </div>
                    <p>{automation.prompt}</p>
                    {#if automation.lastError}
                      <small class="automation-error">{automation.lastError}</small>
                    {/if}
                  </div>
                  <div class="automation-actions">
                    {#if workspace}
                      <Button
                        size="sm"
                        disabled={busy}
                        ariaLabel={`Edit ${automation.name}`}
                        onclick={() => onManage(workspace, automation.id)}
                      >
                        <Pencil size={14} strokeWidth={1.9} aria-hidden="true" />
                        Edit
                      </Button>
                    {/if}
                    <Button
                      size="sm"
                      disabled={busy}
                      ariaLabel={`${automation.enabled ? 'Pause' : resumeLabel(automation)} ${automation.name}`}
                      onclick={() => void setEnabled(group, automation, !automation.enabled)}
                    >
                      {#if automation.enabled}
                        <Pause size={14} strokeWidth={1.9} aria-hidden="true" />
                        Pause
                      {:else}
                        <Play size={14} strokeWidth={1.9} aria-hidden="true" />
                        {resumeLabel(automation)}
                      {/if}
                    </Button>
                    <Button
                      variant="danger-outline"
                      size="sm"
                      disabled={busy}
                      ariaLabel={`Delete ${automation.name}`}
                      onclick={() => void deleteAutomation(group, automation)}
                    >
                      <Trash2 size={14} strokeWidth={1.9} aria-hidden="true" />
                      Delete
                    </Button>
                  </div>
                </article>
              {/each}
            </div>
          {/if}
        </section>
      {/each}
    {/if}
  </div>
</div>

<style>
.overview {
  display: grid;
  width: 100%;
  gap: 1rem;
}
.overview-toolbar,
.workspace-heading,
.automation-list article,
.automation-heading,
.automation-actions {
  display: flex;
  align-items: center;
}
.overview-toolbar {
  justify-content: space-between;
  gap: 1rem;
  padding-bottom: 1rem;
  border-bottom: 1px solid var(--color-border);
}
.overview-toolbar > div,
.workspace-heading > div,
.automation-heading > div {
  display: grid;
  min-width: 0;
  gap: 0.15rem;
}
.overview-toolbar strong {
  color: var(--color-text);
  font-size: var(--text-body);
  font-weight: var(--weight-medium);
}
.overview-toolbar p,
.workspace-heading p,
.automation-copy > p,
.automation-error,
.workspace-empty {
  margin: 0;
}
.overview-toolbar p,
.workspace-heading p,
.automation-heading span {
  color: var(--color-text-tertiary);
  font-size: var(--text-caption);
  line-height: var(--leading-ui);
}
.workspace-groups {
  display: grid;
  gap: 1rem;
}
.workspace-group {
  display: grid;
  gap: 0;
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-control-background);
}
.workspace-heading {
  justify-content: space-between;
  min-height: var(--control-height-lg);
  padding: 0.7rem 0.8rem;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-surface-raised);
}
.workspace-heading h2 {
  overflow: hidden;
  margin: 0;
  color: var(--color-text);
  font-size: var(--text-label);
  font-weight: var(--weight-strong);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.automation-list {
  display: grid;
}
.automation-list article {
  justify-content: space-between;
  gap: 1rem;
  min-width: 0;
  padding: 0.8rem;
  border-bottom: 1px solid var(--color-border);
}
.automation-list article:last-child {
  border-bottom: 0;
}
.automation-list article.paused {
  opacity: 0.72;
}
.automation-copy {
  display: grid;
  min-width: 0;
  gap: 0.35rem;
}
.automation-heading {
  align-items: flex-start;
  min-width: 0;
  gap: 0.55rem;
}
.automation-heading > :global(svg) {
  flex: 0 0 auto;
  margin-top: 0.1rem;
  color: var(--color-command);
}
.automation-heading strong {
  overflow: hidden;
  color: var(--color-text);
  font-size: var(--text-label);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.automation-copy > p {
  display: -webkit-box;
  overflow: hidden;
  color: var(--color-text-secondary);
  font-size: var(--text-label);
  line-height: var(--leading-body);
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
}
.automation-actions {
  flex: 0 0 auto;
  justify-content: flex-end;
  gap: 0.4rem;
}
.automation-error {
  color: var(--color-danger-text);
  font-size: var(--text-caption);
  line-height: var(--leading-ui);
}
.workspace-empty {
  padding: 0.9rem 0.8rem;
  color: var(--color-text-tertiary);
  font-size: var(--text-caption);
  line-height: var(--leading-ui);
}
:global(.automation-empty) {
  gap: 0.65rem;
}
:global(.automation-empty p) {
  margin: 0;
}

@media (max-width: 44rem) {
  .automation-list article {
    align-items: stretch;
    flex-direction: column;
  }
  .automation-actions {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  :global(.automation-actions .vampire-button) {
    width: 100%;
  }
}

@media (max-width: 28rem) {
  .overview-toolbar {
    align-items: stretch;
    flex-direction: column;
  }
  :global(.overview-toolbar .vampire-button) {
    align-self: flex-start;
  }
  .automation-actions {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  :global(.automation-actions .vampire-button--danger-outline) {
    grid-column: 1 / -1;
  }
}
</style>
