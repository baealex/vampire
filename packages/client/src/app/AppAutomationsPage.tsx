import { workspaceName } from '@vampire/lib/features/workspace/model/workspace-view.ts';
import type { ManagedWorkspace } from '@vampire/lib/shared/contracts/workspace.ts';
import type { WorkspaceAutomation } from '@vampire/lib/shared/contracts/workspace-automations.ts';
import { useEffect, useState } from 'react';
import { AutomationManagerDialog } from '~/features/workspace/AutomationManagerDialog.tsx';
import { requestJson } from '~/shared/api/request.ts';
import { Button, Input, ManagementSurface, Select, Spinner } from '~/shared/ui/index.ts';
import './app-automations-page.css';

type Entry = { workspaceId: string; automations: WorkspaceAutomation[] };
const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function scheduleText(automation: WorkspaceAutomation) {
  const schedule = automation.schedule;
  if (schedule.type === 'once') return `One time · ${new Date(schedule.runAt).toLocaleString()}`;
  if (schedule.type === 'interval') return `Every ${Math.round(schedule.intervalMs / 60_000)} min`;
  return `${schedule.weekdays.map((day) => weekdays[day]).join(', ')} · ${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')} · ${schedule.timeZone}`;
}

export function AppAutomationsPage({
  active = true,
  back,
  close,
  embedded = false,
  navigate,
  workspaces,
}: {
  active?: boolean;
  back?: () => void;
  close: () => void;
  embedded?: boolean;
  navigate: (path: string) => void;
  workspaces: ManagedWorkspace[];
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [failedIds, setFailedIds] = useState<string[]>([]);
  const [revision, setRevision] = useState(0);
  const [query, setQuery] = useState('');
  const [workspaceFilter, setWorkspaceFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [creating, setCreating] = useState(false);
  const [editor, setEditor] = useState<{ automationId?: string; workspaceId: string }>();
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState(workspaces[0]?.id ?? '');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const workspaceIds = JSON.stringify(workspaces.map((workspace) => workspace.id).sort());
  useEffect(() => {
    if (!active) return;
    let mounted = true;
    setLoading(true);
    const ids = JSON.parse(workspaceIds) as string[];
    void Promise.allSettled(
      ids.map(async (workspaceId) => ({
        workspaceId,
        automations: (
          await requestJson<{ automations: WorkspaceAutomation[] }>(
            `/api/workspaces/${encodeURIComponent(workspaceId)}/automations`,
            { cache: 'no-store' },
          )
        ).automations,
      })),
    ).then((results) => {
      if (!mounted) return;
      setEntries(results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : [])));
      setFailedIds(results.flatMap((result, index) => (result.status === 'rejected' ? [ids[index]!] : [])));
      setLoading(false);
    });
    return () => {
      mounted = false;
    };
  }, [active, workspaceIds, revision]);
  const all = entries
    .flatMap(({ workspaceId, automations }) => {
      const workspace = workspaces.find((item) => item.id === workspaceId);
      return workspace ? automations.map((automation) => ({ workspace, automation })) : [];
    })
    .sort((a, b) => (a.automation.nextRunAt ?? Infinity) - (b.automation.nextRunAt ?? Infinity));
  const visible = all.filter(
    ({ workspace, automation }) =>
      (!workspaceFilter || workspace.id === workspaceFilter) &&
      (statusFilter === 'all' ||
        (statusFilter === 'enabled'
          ? automation.enabled
          : statusFilter === 'paused'
            ? !automation.enabled
            : Boolean(automation.lastError))) &&
      `${workspaceName(workspace)} ${automation.name} ${automation.prompt}`
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()),
  );
  const activeCount = all.filter(({ automation }) => automation.enabled).length;
  const configured = entries.filter(({ automations }) => automations.length).length;
  const toggle = async (workspaceId: string, automation: WorkspaceAutomation) => {
    if (busy) return;
    setBusy(`${workspaceId}:${automation.id}`);
    setError('');
    try {
      await requestJson(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/automations/${encodeURIComponent(automation.id)}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: !automation.enabled }),
        },
      );
      setRevision((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to update automation.');
    } finally {
      setBusy('');
    }
  };
  const openEditor = (workspaceId: string, automationId?: string) => {
    setCreating(false);
    setEditor({ workspaceId, automationId });
  };
  const closeEditor = () => {
    setEditor(undefined);
    setRevision((value) => value + 1);
  };
  const content =
    editor && embedded ? (
      <div className="all-automations">
        <AutomationManagerDialog
          active={active}
          embedded
          initialAutomationId={editor.automationId}
          initialWorkspaceId={editor.workspaceId}
          onBack={closeEditor}
          onClose={close}
          workspaces={workspaces}
        />
      </div>
    ) : (
      <div className="all-automations">
        <div className="all-automations-toolbar">
          <p>
            {all.length} total · {activeCount} active · {configured} of {workspaces.length} workspace
            {workspaces.length === 1 ? '' : 's'} configured.
          </p>
          <Button onClick={() => setRevision((value) => value + 1)} disabled={loading || Boolean(busy)}>
            Refresh
          </Button>
          <Button variant="primary" onClick={() => setCreating((value) => !value)} disabled={!workspaces.length}>
            New automation
          </Button>
        </div>
        {creating ? (
          <div className="all-automations-create">
            <Select
              aria-label="Workspace for new automation"
              value={selectedWorkspaceId}
              onChange={(event) => setSelectedWorkspaceId(event.currentTarget.value)}
            >
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspaceName(workspace)}
                </option>
              ))}
            </Select>
            <Button
              disabled={!workspaces.some((workspace) => workspace.id === selectedWorkspaceId)}
              onClick={() =>
                embedded
                  ? openEditor(selectedWorkspaceId, 'new')
                  : navigate(`/workspaces/${encodeURIComponent(selectedWorkspaceId)}/automations?edit=new&return=all`)
              }
            >
              Continue
            </Button>
          </div>
        ) : null}
        <div className="all-automations-filters">
          <Input
            aria-label="Search automations"
            placeholder="Search name, workspace, or prompt"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
          <Select
            aria-label="Filter by workspace"
            value={workspaceFilter}
            onChange={(event) => setWorkspaceFilter(event.currentTarget.value)}
          >
            <option value="">All workspaces</option>
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspaceName(workspace)}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Filter by status"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.currentTarget.value)}
          >
            <option value="all">All statuses</option>
            <option value="enabled">Enabled</option>
            <option value="paused">Paused</option>
            <option value="failed">Needs attention</option>
          </Select>
        </div>
        {failedIds.length ? (
          <p role="alert">
            Could not load:{' '}
            {failedIds
              .map((id) => {
                const workspace = workspaces.find((item) => item.id === id);
                return workspace ? workspaceName(workspace) : id;
              })
              .join(', ')}
            . Other workspaces are shown. Use Refresh to retry.
          </p>
        ) : null}
        {error ? <p role="alert">{error}</p> : null}
        {loading ? (
          <p role="status">
            <Spinner /> Loading automations…
          </p>
        ) : null}
        {!loading && !visible.length ? (
          <p>
            {all.length
              ? 'No automations match these filters.'
              : failedIds.length
                ? 'No automations available from the loaded workspaces.'
                : 'No automations yet.'}
          </p>
        ) : null}
        <div className="all-automations-list" aria-label="All automations">
          {visible.map(({ workspace, automation }) => (
            <article key={`${workspace.id}:${automation.id}`}>
              <div className="all-automations-info">
                <h2>{automation.name}</h2>
                <span>
                  {workspaceName(workspace)} · {automation.enabled ? 'Enabled' : 'Paused'}
                </span>
                <span>{scheduleText(automation)}</span>
                <span>
                  Next:{' '}
                  {automation.enabled && automation.nextRunAt
                    ? new Date(automation.nextRunAt).toLocaleString()
                    : 'Not scheduled'}
                </span>
                {automation.lastAttemptAt ? (
                  <span>
                    Last attempt: {new Date(automation.lastAttemptAt).toLocaleString()} ·{' '}
                    {automation.lastOutcome ?? 'Pending'}
                  </span>
                ) : null}
                {automation.lastError ? <p role="alert">{automation.lastError}</p> : null}
                <details>
                  <summary>Prompt</summary>
                  <p>{automation.prompt}</p>
                </details>
              </div>
              <div className="all-automations-actions">
                <Button
                  disabled={Boolean(busy) || loading}
                  onClick={() => void toggle(workspace.id, automation)}
                  aria-label={`${automation.enabled ? 'Pause' : 'Enable'} ${automation.name}`}
                >
                  {automation.enabled ? 'Pause' : 'Enable'}
                </Button>
                <Button
                  aria-label={`Edit ${automation.name}`}
                  onClick={() =>
                    embedded
                      ? openEditor(workspace.id, automation.id)
                      : navigate(
                          `/workspaces/${encodeURIComponent(workspace.id)}/automations?edit=${encodeURIComponent(automation.id)}&return=all`,
                        )
                  }
                >
                  Edit
                </Button>
              </div>
            </article>
          ))}
        </div>
      </div>
    );
  return embedded ? (
    content
  ) : (
    <ManagementSurface
      title="Automations"
      eyebrow="App settings"
      titleId="application-automations-title"
      back={back}
      backLabel="Back to app settings"
      close={close}
      closeLabel="Close automations"
    >
      {content}
    </ManagementSurface>
  );
}
