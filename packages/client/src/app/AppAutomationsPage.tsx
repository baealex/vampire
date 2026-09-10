import { workspaceName } from '@vampire/lib/features/workspace/model/workspace-view.ts';
import type { ManagedWorkspace } from '@vampire/lib/shared/contracts/workspace.ts';
import type { WorkspaceAutomation } from '@vampire/lib/shared/contracts/workspace-automations.ts';
import { Pencil } from 'lucide-react';
import { useEffect, useState } from 'react';
import { requestJson } from '~/shared/api/request.ts';
import { Button, ManagementSurface, Select, Spinner } from '~/shared/ui/index.ts';
import '~/features/workspace/automation-manager-dialog.css';

type Entry = { workspace: ManagedWorkspace; automations: WorkspaceAutomation[] };
export function AppAutomationsPage({
  close,
  navigate,
  workspaces,
}: {
  close: () => void;
  navigate: (path: string) => void;
  workspaces: ManagedWorkspace[];
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState(workspaces[0]?.id ?? '');
  useEffect(() => {
    let active = true;
    void Promise.all(
      workspaces.map(async (workspace) => ({
        workspace,
        automations: (
          await requestJson<{ automations: WorkspaceAutomation[] }>(
            `/api/workspaces/${encodeURIComponent(workspace.id)}/automations`,
            { cache: 'no-store' },
          )
        ).automations,
      })),
    )
      .then((value) => {
        if (active) setEntries(value);
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : 'Unable to load automations.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [workspaces]);
  const all = entries.flatMap(({ workspace, automations }) =>
    automations.map((automation) => ({ workspace, automation })),
  );
  const active = all.filter(({ automation }) => automation.enabled).length;
  const configured = entries.filter(({ automations }) => automations.length).length;
  return (
    <ManagementSurface
      title="Automations"
      titleId="application-automations-title"
      eyebrow="Server settings"
      close={close}
      closeLabel="Close all automations"
    >
      <div className="automation-manager">
        <p className="automation-summary">
          {active} active · {configured} of {workspaces.length} workspace{workspaces.length === 1 ? '' : 's'}{' '}
          configured.
        </p>
        {workspaces.length > 0 ? (
          <div className="automation-toolbar">
            <Select
              aria-label="Workspace for automations"
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
              onClick={() => navigate(`/workspaces/${encodeURIComponent(selectedWorkspaceId)}/automations?return=all`)}
              disabled={!selectedWorkspaceId}
            >
              Manage automations
            </Button>
          </div>
        ) : null}
        {loading ? (
          <div className="automation-loading">
            <Spinner />
            Loading automations…
          </div>
        ) : !error && all.length === 0 ? (
          <div className="automation-empty">
            <strong>No automations yet</strong>
            <p>
              {workspaces.length
                ? 'Choose a workspace above to schedule your first prompt.'
                : 'Open a project to schedule prompts for its agent.'}
            </p>
            {!workspaces.length ? <Button onClick={() => navigate('/')}>Open a project</Button> : null}
          </div>
        ) : (
          <div className="automation-list">
            {all.map(({ workspace, automation }) => (
              <article key={`${workspace.id}-${automation.id}`}>
                <div>
                  <strong>{automation.name}</strong>
                  <span>{workspaceName(workspace)}</span>
                  <p>{automation.prompt}</p>
                </div>
                <Button
                  variant="icon"
                  aria-label={`Edit ${automation.name}`}
                  onClick={() =>
                    navigate(
                      `/workspaces/${encodeURIComponent(workspace.id)}/automations?edit=${encodeURIComponent(automation.id)}&return=all`,
                    )
                  }
                >
                  <Pencil size={15} />
                </Button>
              </article>
            ))}
          </div>
        )}
        {error ? <p role="alert">{error}</p> : null}
      </div>
    </ManagementSurface>
  );
}
