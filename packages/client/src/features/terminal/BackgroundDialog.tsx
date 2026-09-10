import {
  loadWorkspaceAgentAction,
  submitWorkspaceAgentAction,
} from '@vampire/lib/shared/api/workspace-agent-actions.ts';
import type { ManagedWorkspace, WorkspaceTerminal } from '@vampire/lib/shared/contracts/workspace.ts';
import { Play, Plus, RotateCcw, Sparkles, Square, SquareTerminal, Star, Trash2 } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AskAgentPanel,
  Button,
  Input,
  PanelState,
  ToolbarButton,
  WorkspacePanelHeader,
  WorkspaceSidePanel,
} from '~/shared/ui/index.ts';
import './background-dialog.css';

type View = 'list' | 'runner' | 'output' | 'agent';
type BackgroundController = {
  backgroundActionError: string;
  backgroundActionErrorWorkspaceId?: string;
  startingBackgroundWorkspaceId?: string;
  workspaces: ManagedWorkspace[];
  favoriteBackgroundCommand(workspaceId: string, command: string): Promise<boolean>;
  loadBackgroundOutput(workspaceId: string, processId: string): Promise<string>;
  removeBackgroundCommandFavorite(workspaceId: string, command: string): Promise<boolean>;
  startBackgroundProcess(workspaceId: string, command: string): Promise<WorkspaceTerminal | undefined>;
  stopBackgroundProcess(workspaceId: string, processId: string): Promise<boolean>;
};
const processCommand = (process: WorkspaceTerminal) =>
  process.command || process.name || process.foregroundProcess?.label || 'Background command';
const processStatus = (process: WorkspaceTerminal) =>
  process.state === 'running'
    ? 'Running'
    : process.exitCode === 0
      ? 'Finished'
      : process.exitCode === null
        ? 'Exited'
        : `Failed (${process.exitCode})`;
const BACKGROUND_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const processStartedAt = (process: WorkspaceTerminal) =>
  process.startedAt ? BACKGROUND_TIME_FORMATTER.format(process.startedAt) : undefined;

export const BackgroundDialog = observer(function BackgroundDialog({
  onClose,
  open,
  state,
  workspaceId,
  workspaceLabel,
}: {
  onClose: () => void;
  open: boolean;
  state: BackgroundController;
  workspaceId: string;
  workspaceLabel: string;
}) {
  const workspace = state.workspaces.find((item) => item.id === workspaceId);
  const processes = useMemo(
    () => [...(workspace?.terminals.slice(1) ?? [])].sort((a, b) => a.index - b.index),
    [workspace?.terminals],
  );
  const favorites = workspace?.favoriteCommands ?? [];
  const runningCommands = new Set(processes.filter((process) => process.state === 'running').map(processCommand));
  const [view, setView] = useState<View>('list');
  const [command, setCommand] = useState('');
  const [selectedId, setSelectedId] = useState<string>();
  const [output, setOutput] = useState('');
  const [outputError, setOutputError] = useState('');
  const [loadingOutput, setLoadingOutput] = useState(false);
  const commandInput = useRef<HTMLInputElement>(null);
  const selected = processes.find((process) => process.id === selectedId);

  useEffect(() => {
    if (!open || view !== 'output' || !selectedId) return;
    let active = true;
    let refreshing = false;
    const refresh = async (initial = false) => {
      if (refreshing || document.hidden) return;
      refreshing = true;
      if (initial) setLoadingOutput(true);
      try {
        const value = await state.loadBackgroundOutput(workspaceId, selectedId);
        if (active) {
          setOutput(value);
          setOutputError('');
        }
      } catch (cause) {
        if (active) setOutputError(cause instanceof Error ? cause.message : 'Unable to read output');
      } finally {
        if (active) setLoadingOutput(false);
        refreshing = false;
      }
    };
    void refresh(true);
    const timer = window.setInterval(() => void refresh(), 1_500);
    const refreshWhenVisible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [open, selectedId, state, view, workspaceId]);
  useEffect(() => {
    if (selectedId && !processes.some((process) => process.id === selectedId)) showList();
  }, [processes, selectedId]);

  const showList = () => {
    setView('list');
    setSelectedId(undefined);
    setOutput('');
    setOutputError('');
  };
  const run = async (value: string) => {
    const normalized = value.trim();
    if (!normalized || runningCommands.has(normalized)) return;
    const process = await state.startBackgroundProcess(workspaceId, normalized);
    if (!process) return;
    setCommand('');
    setSelectedId(process.id);
    setOutput('');
    setView('output');
  };
  const stop = async (process: WorkspaceTerminal) => {
    if (await state.stopBackgroundProcess(workspaceId, process.id)) showList();
  };
  const close = () => {
    showList();
    onClose();
    window.setTimeout(() => document.getElementById('background-process-trigger')?.focus());
  };
  const title = view === 'runner' ? 'Run command' : view === 'output' ? 'Output' : 'Background';
  const favoriteStrip = favorites.length ? (
    <section className="favorite-strip" aria-label="Saved background commands">
      <span className="favorite-heading">
        <span>
          <Star size={12} /> Saved commands
        </span>
        <small>{favorites.length}</small>
      </span>
      <div className="favorite-list">
        {favorites.map((favorite) => (
          <div className="favorite-command" key={favorite}>
            <button
              type="button"
              className="favorite-run"
              disabled={runningCommands.has(favorite)}
              aria-label={`Run saved command ${favorite}`}
              onClick={() => void run(favorite)}
            >
              <Play size={15} />
              <code>{favorite}</code>
            </button>
            <button
              type="button"
              className="favorite-remove"
              aria-label={`Remove saved command ${favorite}`}
              onClick={() => void state.removeBackgroundCommandFavorite(workspaceId, favorite)}
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
    </section>
  ) : null;

  return (
    <WorkspaceSidePanel
      open={open}
      className="background-panel"
      aria-label={view === 'agent' ? 'Manage Background commands with an agent' : title}
    >
      {view === 'agent' ? (
        <div className="background-agent-view">
          <AskAgentPanel
            close={showList}
            load={() => loadWorkspaceAgentAction(workspaceId, 'background')}
            submit={(request) => submitWorkspaceAgentAction(workspaceId, 'background', request)}
          />
        </div>
      ) : (
        <>
          <WorkspacePanelHeader
            title={title}
            subtitle={workspaceLabel}
            subtitleTitle={workspace?.cwd}
            onBack={view !== 'list' ? showList : undefined}
            backLabel="Back to background processes"
            close={close}
            closeLabel="Close background manager"
            actions={
              view === 'list' ? (
                <>
                  <Button
                    id="background-ask-agent-trigger"
                    size="sm"
                    aria-label="Ask agent to manage saved commands"
                    onClick={() => setView('agent')}
                  >
                    <Sparkles size={15} />
                    Ask agent…
                  </Button>
                  <ToolbarButton
                    label="Run background command"
                    onClick={() => {
                      setView('runner');
                      window.setTimeout(() => commandInput.current?.focus());
                    }}
                  >
                    <Plus size={18} />
                  </ToolbarButton>
                </>
              ) : null
            }
          />
          <div className={`background-view${view === 'output' ? ' output-view' : ''}`}>
            {view === 'runner' ? (
              <>
                <div className="background-location">
                  <span>Working directory</span>
                  <code title={workspace?.cwd}>{workspace?.cwd}</code>
                </div>
                <form
                  className="background-runner"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void run(command);
                  }}
                >
                  <label>
                    Command
                    <Input
                      ref={commandInput}
                      mono
                      value={command}
                      onChange={(event) => setCommand(event.currentTarget.value)}
                      aria-label="Background command"
                      placeholder="e.g. pnpm dev"
                    />
                  </label>
                  <Button
                    type="submit"
                    variant="primary"
                    disabled={!command.trim() || state.startingBackgroundWorkspaceId === workspaceId}
                  >
                    Run
                  </Button>
                </form>
                {favoriteStrip}
              </>
            ) : view === 'output' && selected ? (
              <>
                <div className="background-location">
                  <span>Command</span>
                  <code>{processCommand(selected)}</code>
                </div>
                <div className="background-detail-bar">
                  <span className="background-process-state" data-state={selected.state}>
                    <i aria-hidden="true" />
                    {processStatus(selected)}
                    {processStartedAt(selected) ? (
                      <time
                        dateTime={new Date(selected.startedAt!).toISOString()}
                        title={new Date(selected.startedAt!).toLocaleString()}
                      >
                        since {processStartedAt(selected)}
                      </time>
                    ) : null}
                  </span>
                  <Button
                    variant="icon"
                    aria-pressed={favorites.includes(processCommand(selected))}
                    aria-label={
                      favorites.includes(processCommand(selected))
                        ? `Remove saved command ${processCommand(selected)}`
                        : `Save command ${processCommand(selected)}`
                    }
                    onClick={() =>
                      void (favorites.includes(processCommand(selected))
                        ? state.removeBackgroundCommandFavorite(workspaceId, processCommand(selected))
                        : state.favoriteBackgroundCommand(workspaceId, processCommand(selected)))
                    }
                  >
                    <Star size={15} />
                  </Button>
                  {selected.state === 'exited' ? (
                    <Button
                      variant="icon"
                      aria-label={`Run ${processCommand(selected)} again`}
                      onClick={() => void run(processCommand(selected))}
                    >
                      <RotateCcw size={15} />
                    </Button>
                  ) : null}
                  <Button
                    variant="danger-outline"
                    aria-label={
                      selected.state === 'running'
                        ? `Stop ${processCommand(selected)}`
                        : `Delete ${processCommand(selected)}`
                    }
                    onClick={() => void stop(selected)}
                  >
                    {selected.state === 'running' ? <Square size={15} /> : <Trash2 size={15} />}
                    {selected.state === 'running' ? 'Stop' : 'Delete'}
                  </Button>
                </div>
                <section className="process-output" aria-label={`Output for ${processCommand(selected)}`}>
                  {outputError ? (
                    <PanelState error>{outputError}</PanelState>
                  ) : loadingOutput ? (
                    <PanelState loading>Loading output…</PanelState>
                  ) : (
                    <pre>
                      {output || (selected.state === 'running' ? 'Waiting for output…' : 'No output captured.')}
                    </pre>
                  )}
                </section>
              </>
            ) : (
              <>
                {favoriteStrip}
                <section className="process-section">
                  <header>
                    <strong>Processes</strong>
                    <span>
                      {processes.filter((process) => process.state === 'running').length
                        ? `${processes.filter((process) => process.state === 'running').length} running · ${processes.length} total`
                        : `${processes.length} completed`}
                    </span>
                  </header>
                  <div className="process-list" aria-label="Background process list">
                    {processes.length ? (
                      processes.map((process) => (
                        <div className="process-row" key={process.id}>
                          <button
                            type="button"
                            className="process-summary"
                            aria-label={`View output for ${processCommand(process)}`}
                            onClick={() => {
                              setSelectedId(process.id);
                              setView('output');
                            }}
                          >
                            <code>{processCommand(process)}</code>
                            <span className="process-row-meta">
                              <i data-state={process.state} aria-hidden="true" />
                              <span>{processStatus(process)}</span>
                              {processStartedAt(process) ? (
                                <time
                                  dateTime={new Date(process.startedAt!).toISOString()}
                                  title={new Date(process.startedAt!).toLocaleString()}
                                >
                                  {processStartedAt(process)}
                                </time>
                              ) : null}
                            </span>
                          </button>
                          {process.state === 'exited' ? (
                            <Button
                              variant="icon"
                              aria-label={`Run ${processCommand(process)} again`}
                              onClick={() => void run(processCommand(process))}
                            >
                              <RotateCcw size={14} />
                            </Button>
                          ) : null}
                          <Button
                            variant="icon"
                            aria-label={
                              process.state === 'running'
                                ? `Stop ${processCommand(process)}`
                                : `Delete ${processCommand(process)}`
                            }
                            onClick={() => void stop(process)}
                          >
                            {process.state === 'running' ? <Square size={14} /> : <Trash2 size={14} />}
                          </Button>
                        </div>
                      ))
                    ) : (
                      <div className="background-empty">
                        <SquareTerminal size={22} strokeWidth={1.6} aria-hidden="true" />
                        <strong>No background processes</strong>
                        <p>Run a dev server, watcher, or other long-lived command without leaving this workspace.</p>
                        <Button
                          size="sm"
                          onClick={() => {
                            setView('runner');
                            window.setTimeout(() => commandInput.current?.focus());
                          }}
                        >
                          <Plus size={15} />
                          Run a command
                        </Button>
                      </div>
                    )}
                  </div>
                </section>
              </>
            )}
            {state.backgroundActionErrorWorkspaceId === workspaceId ? (
              <p className="background-error" role="alert">
                {state.backgroundActionError}
              </p>
            ) : null}
          </div>
        </>
      )}
    </WorkspaceSidePanel>
  );
});
