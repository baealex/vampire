import { Pencil } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ManagedWorkspace } from '@vampire/lib/shared/contracts/workspace.ts';
import type { WorkspaceAutomation } from '@vampire/lib/shared/contracts/workspace-automations.ts';
import { workspaceName } from '@vampire/lib/features/workspace/model/workspace-view.ts';
import { requestJson } from '~/shared/api/request.ts';
import { Button, ManagementSurface, Spinner } from '~/shared/ui/index.ts';

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
  useEffect(() => {
    let active = true;
    void Promise.all(
      workspaces.map(async (workspace) => ({
        workspace,
        automations: (
          await requestJson<{ automations: WorkspaceAutomation[] }>(
            `/api/workspaces/${encodeURIComponent(workspace.id)}/automations`,
            { cache: 'no-store' }
          )
        ).automations,
      }))
    )
      .then((value) => {
        if (active) setEntries(value);
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : 'Unable to load automations.'))
      .finally(() => setLoading(false));
    return () => {
      active = false;
    };
  }, [workspaces]);
  const all = entries.flatMap(({ workspace, automations }) =>
    automations.map((automation) => ({ workspace, automation }))
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
        <p>
          {active} active · {configured} of {workspaces.length} workspace{workspaces.length === 1 ? '' : 's'}{' '}
          configured.
        </p>
        {loading ? (
          <div className="automation-loading">
            <Spinner />
            Loading automations…
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
                      `/workspaces/${encodeURIComponent(workspace.id)}/automations?edit=${encodeURIComponent(automation.id)}&return=all`
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
