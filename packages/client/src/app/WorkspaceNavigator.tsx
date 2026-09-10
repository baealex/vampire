import { ChevronRight, CirclePlay, GitBranch, Plus, SquareTerminal, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { AppSidebarActions } from '~/app/AppSidebarActions.tsx';
import {
  formatWorkspaceTimestamp,
  isWorktreeWorkspace,
  latestWorkspaceOutputAt,
  workspaceActivityLabel,
  workspaceActivityState,
  workspaceName,
  workspaceRepositoryName,
  workspaceProcess,
} from '@vampire/lib/features/workspace/model/workspace-view.ts';
import { Button } from '~/shared/ui/index.ts';
import { WorkspaceActionsMenu } from '~/features/workspace/WorkspaceActionsMenu.tsx';
import { WorkspaceDirectoryPicker } from '~/features/workspace/WorkspaceDirectoryPicker.tsx';
import type { WorkspaceState } from '~/features/workspace/model/workspace-state.ts';
import '../features/workspace/workspace-navigator.css';

export const WorkspaceNavigator = observer(function WorkspaceNavigator({
  onAutomations,
  onNewWorktree,
  onClose,
  onPorts,
  onSettings,
  onWorkspaceSettings,
  mobileOpen,
  state,
}: {
  onAutomations: (workspaceId: string) => void;
  onNewWorktree: (workspaceId: string) => void;
  onClose: () => void;
  onPorts: () => void;
  onSettings: () => void;
  onWorkspaceSettings: (workspaceId: string) => void;
  mobileOpen: boolean;
  state: WorkspaceState;
}) {
  const [now, setNow] = useState(Date.now());
  const [endedOpen, setEndedOpen] = useState(false);
  const [actionMenuId, setActionMenuId] = useState<string>();
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (state.activeWorkspace?.state === 'missing') setEndedOpen(true);
  }, [state.activeWorkspace?.state]);
  const groups = [
    { state: 'active', label: 'Working' },
    { state: 'review', label: 'Review needed' },
    { state: 'idle', label: 'Idle' },
    { state: 'ended', label: 'Ended' },
  ].map((group) => ({
    ...group,
    workspaces: state.displayedWorkspaces.filter(
      (workspace) => workspaceActivityState(workspace, state.activityRecords, now) === group.state
    ),
  }));
  const renderRows = (workspaces: typeof state.workspaces) =>
    workspaces.map((workspace) => {
      const activity = workspaceActivityState(workspace, state.activityRecords, now);
      const name = workspaceName(workspace);
      const outputAt = latestWorkspaceOutputAt(workspace);
      const process = workspaceProcess(workspace);
      const backgroundCount = Math.max(0, workspace.terminals.length - 1);
      return (
        <div
          className={`workspace-row-shell${state.requestedWorkspaceId === workspace.id ? ' selected' : ''}`}
          key={workspace.id}
        >
          <button
            className="workspace-row"
            data-workspace-id={workspace.id}
            type="button"
            aria-current={state.requestedWorkspaceId === workspace.id ? 'true' : undefined}
            aria-label={`Open ${workspace.state === 'missing' ? 'ended' : 'running'} ${name} workspace`}
            onClick={() => {
              state.openWorkspace(workspace);
              state.markWorkspaceObserved(workspace.id);
              onClose();
            }}
            onKeyDown={(event) => {
              if (
                state.workspaceOrderMode !== 'manual' ||
                !event.altKey ||
                !['ArrowUp', 'ArrowDown'].includes(event.key)
              )
                return;
              event.preventDefault();
              const index = state.displayedWorkspaces.findIndex((item) => item.id === workspace.id);
              const target = state.displayedWorkspaces[index + (event.key === 'ArrowUp' ? -1 : 1)];
              if (target) state.reorderWorkspace(workspace.id, target.id, event.key === 'ArrowUp' ? 'before' : 'after');
            }}
          >
            <span className="workspace-title">
              <strong>{name}</strong>
            </span>
            {isWorktreeWorkspace(workspace) ? (
              <span className="workspace-origin">
                <GitBranch size={12} strokeWidth={1.8} aria-hidden="true" />
                {workspaceRepositoryName(workspace)}
                {workspace.worktreeBranch ? ` · ${workspace.worktreeBranch}` : ''}
              </span>
            ) : null}
            <span className="agent-summary">
              <span className={`status-dot ${activity}`} aria-hidden="true" />
              {process ? (
                <>
                  <span className="workspace-program">{process.label}</span>
                  <span aria-hidden="true">·</span>
                </>
              ) : null}
              <span className={state.workspaceOrderMode === 'manual' ? 'workspace-state' : undefined}>
                {workspaceActivityLabel(activity)}
              </span>
              <span aria-hidden="true">·</span>
              <time dateTime={new Date(outputAt).toISOString()}>{formatWorkspaceTimestamp(outputAt, now)}</time>
            </span>
            {backgroundCount > 0 ? (
              <span
                className="runtime-summary"
                title={`${backgroundCount} background ${backgroundCount === 1 ? 'process' : 'processes'} in this workspace`}
              >
                <CirclePlay size={13} aria-hidden="true" />
                <span>{backgroundCount} background</span>
              </span>
            ) : null}
          </button>
          <div className="workspace-actions-menu">
            <WorkspaceActionsMenu
              open={actionMenuId === workspace.id}
              onOpenChange={(open) => setActionMenuId(open ? workspace.id : undefined)}
              state={state}
              workspace={workspace}
              onAutomations={() => {
                onClose();
                onAutomations(workspace.id);
              }}
              onNewWorktree={() => {
                onClose();
                onNewWorktree(workspace.id);
              }}
              onSettings={() => {
                onClose();
                onWorkspaceSettings(workspace.id);
              }}
            />
          </div>
        </div>
      );
    });
  return (
    <aside className={`workspace-column${mobileOpen ? ' mobile-open' : ''}`}>
      <section className="workspace-panel" aria-label="Workspace list">
        <AppSidebarActions
          onPorts={() => {
            onClose();
            onPorts();
          }}
          onSettings={() => {
            onClose();
            onSettings();
          }}
        />
        <header className="workspace-navigator-heading">
          <strong>Workspaces</strong>
          <button
            className="new-workspace-button"
            type="button"
            aria-label="New workspace"
            title="New workspace"
            onClick={() => {
              state.newWorkspaceOpen = true;
            }}
          >
            <Plus size={17} strokeWidth={2} aria-hidden="true" />
          </button>
          <button
            className="close-workspace-navigator"
            type="button"
            aria-label="Close workspace navigator"
            onClick={onClose}
          >
            <X size={17} aria-hidden="true" />
          </button>
        </header>
        <div className="workspace-order-toolbar">
          <span>Order by</span>
          <button
            type="button"
            aria-label="Group workspaces by status"
            aria-pressed={state.workspaceOrderMode === 'activity'}
            className={state.workspaceOrderMode === 'activity' ? 'active' : ''}
            onClick={() => state.setWorkspaceOrderMode('activity')}
          >
            Activity
          </button>
          <button
            type="button"
            aria-label="Arrange workspaces manually"
            aria-pressed={state.workspaceOrderMode === 'manual'}
            className={state.workspaceOrderMode === 'manual' ? 'active' : ''}
            onClick={() => state.setWorkspaceOrderMode('manual')}
          >
            Manual
          </button>
        </div>
        {state.errorMessage ? (
          <p className="panel-message" role="alert">
            {state.errorMessage}
          </p>
        ) : state.workspaces.length === 0 ? (
          <Empty state={state} />
        ) : (
          <div className="workspaces">
            {state.workspaceOrderMode === 'manual'
              ? renderRows(state.displayedWorkspaces)
              : groups
                  .filter((group) => group.workspaces.length)
                  .map((group) => (
                    <section
                      className={`workspace-group ${group.state === 'active' ? 'working' : group.state}`}
                      key={group.state}
                      aria-labelledby={`workspace-group-${group.state}`}
                    >
                      {group.state === 'ended' ? (
                        <>
                          <button
                            type="button"
                            className="workspace-group-header workspace-group-toggle"
                            aria-expanded={endedOpen}
                            onClick={() => setEndedOpen((open) => !open)}
                          >
                            <span id="workspace-group-ended">{group.label}</span>
                            <span className="workspace-group-count">{group.workspaces.length}</span>
                            <ChevronRight size={14} className={endedOpen ? 'expanded' : ''} />
                          </button>
                          {endedOpen ? renderRows(group.workspaces) : null}
                        </>
                      ) : (
                        <>
                          <h2 className="workspace-group-header" id={`workspace-group-${group.state}`}>
                            <span>{group.label}</span>
                            <span className="workspace-group-count">{group.workspaces.length}</span>
                          </h2>
                          {renderRows(group.workspaces)}
                        </>
                      )}
                    </section>
                  ))}
          </div>
        )}
      </section>
      {state.newWorkspaceOpen ? <WorkspaceDirectoryPicker state={state} /> : null}
    </aside>
  );
});

function Empty({ state }: { state: WorkspaceState }) {
  return (
    <div className="workspace-empty">
      <SquareTerminal size={24} strokeWidth={1.7} aria-hidden="true" />
      <h2>No workspaces yet</h2>
      <p>Open a project shell. The workspace stays available until you remove it.</p>
      <Button
        onClick={() => {
          state.newWorkspaceOpen = true;
        }}
      >
        New workspace
      </Button>
    </div>
  );
}
