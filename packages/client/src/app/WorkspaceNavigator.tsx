import { RestrictToVerticalAxis } from '@dnd-kit/abstract/modifiers';
import { DragDropProvider, KeyboardSensor, PointerSensor } from '@dnd-kit/react';
import { isSortable, useSortable } from '@dnd-kit/react/sortable';
import {
  formatWorkspaceTimestamp,
  isWorktreeWorkspace,
  latestWorkspaceOutputAt,
  workspaceActivityLabel,
  workspaceActivityState,
  workspaceName,
  workspaceProcess,
  workspaceRepositoryName,
} from '@vampire/lib/features/workspace/model/workspace-view.ts';
import {
  ArrowDownWideNarrow,
  ChevronRight,
  CirclePlay,
  GitFork,
  GripVertical,
  MessageSquare,
  Plus,
  SlidersHorizontal,
  SquareTerminal,
  StickyNote,
  X,
} from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { type PropsWithChildren, useEffect, useState } from 'react';
import { AppSidebarActions } from '~/app/AppSidebarActions.tsx';
import type { WorkspaceState } from '~/features/workspace/model/workspace-state.ts';
import { WorkspaceActionsMenu } from '~/features/workspace/WorkspaceActionsMenu.tsx';
import { WorkspaceDirectoryPicker } from '~/features/workspace/WorkspaceDirectoryPicker.tsx';
import {
  Button,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '~/shared/ui/index.ts';
import '../features/workspace/workspace-navigator.css';

const SHOW_NOTES_KEY = 'vampire:sidebar-show-notes';
const SHOW_LAST_MESSAGE_KEY = 'vampire:sidebar-show-last-message';
const orderMenuKey = '__workspace-order-menu__';
const viewMenuKey = '__workspace-view-menu__';
const DEFAULT_POINTER_ACTIVATION = PointerSensor.defaults.activationConstraints;
const WORKSPACE_SENSORS = [
  PointerSensor.configure({
    activationConstraints: (event, source) => {
      if (event.pointerType === 'touch') return undefined;
      return typeof DEFAULT_POINTER_ACTIVATION === 'function'
        ? DEFAULT_POINTER_ACTIVATION(event, source)
        : DEFAULT_POINTER_ACTIVATION;
    },
  }),
  KeyboardSensor,
];
const WORKSPACE_MODIFIERS = [RestrictToVerticalAxis];

export const WorkspaceNavigator = observer(function WorkspaceNavigator({
  onNewWorktree,
  onClose,
  onPorts,
  onSettings,
  onWorkspaceSettings,
  mobileOpen,
  state,
}: {
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
  const [openMenuKey, setOpenMenuKey] = useState<string>();
  const [showNotes, setShowNotes] = useState(() => {
    try {
      return localStorage.getItem(SHOW_NOTES_KEY) !== 'false';
    } catch {
      return true;
    }
  });
  const [showLastMessage, setShowLastMessage] = useState(() => {
    try {
      return localStorage.getItem(SHOW_LAST_MESSAGE_KEY) === 'true';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(SHOW_NOTES_KEY, String(showNotes));
      localStorage.setItem(SHOW_LAST_MESSAGE_KEY, String(showLastMessage));
    } catch {
      // Keep the control usable when browser storage is unavailable.
    }
  }, [showNotes, showLastMessage]);
  const setMenuOpen = (key: string, open: boolean) =>
    setOpenMenuKey((current) => (open ? key : current === key ? undefined : current));
  useEffect(() => {
    const update = () => {
      if (!document.hidden) setNow(Date.now());
    };
    const timer = window.setInterval(update, 1_000);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);
  useEffect(() => {
    if (state.activeWorkspace?.state === 'missing' && !state.workspaceAction) setEndedOpen(true);
  }, [state.activeWorkspace?.state, state.workspaceAction]);
  const groups = [
    { state: 'active', label: 'Working' },
    { state: 'review', label: 'Review needed' },
    { state: 'idle', label: 'Idle' },
    { state: 'ended', label: 'Ended' },
  ].map((group) => ({
    ...group,
    workspaces: state.displayedWorkspaces.filter(
      (workspace) => workspaceActivityState(workspace, state.activityRecords, now) === group.state,
    ),
  }));
  const renderRows = (workspaces: typeof state.workspaces) =>
    workspaces.map((workspace, index) => {
      const activity = workspaceActivityState(workspace, state.activityRecords, now);
      const name = workspaceName(workspace);
      const outputAt = latestWorkspaceOutputAt(workspace);
      const process = workspaceProcess(workspace);
      const backgroundCount = Math.max(0, workspace.terminals.length - 1);
      return (
        <WorkspaceRowShell
          key={workspace.id}
          id={workspace.id}
          index={index}
          name={name}
          selected={state.requestedWorkspaceId === workspace.id}
          manual={state.workspaceOrderMode === 'manual'}
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
            <span className="workspace-title" title={name}>
              <strong>{name}</strong>
            </span>
            {isWorktreeWorkspace(workspace) ? (
              <span className="workspace-origin">
                <GitFork size={12} strokeWidth={1.8} aria-hidden="true" />
                {workspaceRepositoryName(workspace)}
              </span>
            ) : null}
            <span className="agent-summary">
              <span className={`status-dot ${activity}`} aria-hidden="true" />
              <span className="workspace-state">{workspaceActivityLabel(activity)}</span>
              {process ? (
                <span className="workspace-program" title={process.label}>
                  {process.label}
                </span>
              ) : null}
              <time title={new Date(outputAt).toLocaleString()} dateTime={new Date(outputAt).toISOString()}>
                {formatWorkspaceTimestamp(outputAt, now)}
              </time>
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
            {(showNotes && workspace.notePreview) || (showLastMessage && workspace.composerPromptPreview) ? (
              <span className="workspace-previews">
                {showNotes && workspace.notePreview ? (
                  <span className="workspace-note-preview" title={`Note: ${workspace.notePreview}`}>
                    <StickyNote size={13} strokeWidth={1.7} aria-hidden="true" />
                    <span>{workspace.notePreview}</span>
                  </span>
                ) : null}
                {showLastMessage && workspace.composerPromptPreview ? (
                  <span
                    className="workspace-message-preview"
                    title={`Last message: ${workspace.composerPromptPreview.text}`}
                  >
                    <MessageSquare size={13} strokeWidth={1.7} aria-hidden="true" />
                    <span>{workspace.composerPromptPreview.text}</span>
                  </span>
                ) : null}
              </span>
            ) : null}
          </button>
          <div className="workspace-actions-menu">
            <WorkspaceActionsMenu
              open={openMenuKey === workspace.id}
              onOpenChange={(open) => setMenuOpen(workspace.id, open)}
              state={state}
              workspace={workspace}
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
        </WorkspaceRowShell>
      );
    });
  return (
    <aside className={`workspace-column${mobileOpen ? ' mobile-open' : ''}`}>
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
      <section className="workspace-panel" aria-label="Workspace list">
        <header className="workspace-navigator-heading">
          <strong>Workspaces</strong>
          <DropdownMenu
            open={openMenuKey === orderMenuKey}
            onOpenChange={(open) => setMenuOpen(orderMenuKey, open)}
            label="Order by"
            title={`Order by: ${state.workspaceOrderMode === 'manual' ? 'Manual' : 'Activity'}`}
            align="end"
            trigger={<ArrowDownWideNarrow size={16} aria-hidden="true" />}
          >
            <DropdownMenuRadioGroup
              value={state.workspaceOrderMode}
              onValueChange={(value) => state.setWorkspaceOrderMode(value === 'manual' ? 'manual' : 'activity')}
            >
              <DropdownMenuRadioItem value="activity">Activity</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="manual">Manual</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenu>
          <DropdownMenu
            open={openMenuKey === viewMenuKey}
            onOpenChange={(open) => setMenuOpen(viewMenuKey, open)}
            label="Workspace view options"
            title="View options"
            align="end"
            trigger={<SlidersHorizontal size={16} aria-hidden="true" />}
          >
            <DropdownMenuCheckboxItem
              checked={showNotes}
              onCheckedChange={(checked) => setShowNotes(checked === true)}
              onSelect={(event) => event.preventDefault()}
            >
              Show notes
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={showLastMessage}
              onCheckedChange={(checked) => setShowLastMessage(checked === true)}
              onSelect={(event) => event.preventDefault()}
            >
              Show last message
            </DropdownMenuCheckboxItem>
          </DropdownMenu>
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
        {state.errorMessage ? (
          <p className="panel-message" role="alert">
            {state.errorMessage}
          </p>
        ) : state.workspaces.length === 0 ? (
          <Empty state={state} />
        ) : (
          <DragDropProvider
            sensors={WORKSPACE_SENSORS}
            modifiers={WORKSPACE_MODIFIERS}
            onDragEnd={(event) => {
              if (event.canceled || state.workspaceOrderMode !== 'manual') return;
              const { source } = event.operation;
              if (!isSortable(source) || source.initialIndex === source.index) return;
              const target = state.displayedWorkspaces[source.index];
              if (target && state.displayedWorkspaces.some((workspace) => workspace.id === source.id)) {
                state.reorderWorkspace(
                  String(source.id),
                  target.id,
                  source.index > source.initialIndex ? 'after' : 'before',
                );
              }
            }}
          >
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
          </DragDropProvider>
        )}
      </section>
      {state.newWorkspaceOpen ? <WorkspaceDirectoryPicker state={state} /> : null}
    </aside>
  );
});

function WorkspaceRowShell({
  children,
  id,
  index,
  manual,
  name,
  selected,
}: PropsWithChildren<{
  id: string;
  index: number;
  manual: boolean;
  name: string;
  selected: boolean;
}>) {
  const { ref, handleRef, isDragging } = useSortable({ id, index, disabled: !manual });
  return (
    <div
      ref={manual ? ref : undefined}
      className={`workspace-row-shell${selected ? ' selected' : ''}${manual ? ' manual' : ''}${isDragging ? ' dragging' : ''}`}
    >
      {manual ? (
        <button
          ref={handleRef}
          type="button"
          className="workspace-drag-handle"
          aria-label={`Reorder ${name}`}
          title="Drag to reorder. With keyboard, press Space, then arrow keys, then Space to drop."
        >
          <GripVertical size={16} aria-hidden="true" />
        </button>
      ) : null}
      {children}
    </div>
  );
}

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
