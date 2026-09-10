import { Activity, GitBranch, ListTree, PanelLeft, StickyNote } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import type { WorkspaceEntryDragData } from '@vampire/lib/shared/lib/workspace-entry-drag.ts';
import type { StatusPluginSnapshot } from '@vampire/lib/shared/contracts/status-plugin.ts';
import { isWorktreeWorkspace, workspaceName } from '@vampire/lib/features/workspace/model/workspace-view.ts';
import { RepositoryClient } from '@vampire/lib/features/repository/api/client.ts';
import { uploadSelectionFromDataTransfer } from '@vampire/lib/features/repository/api/upload.ts';
import { StatusPluginBar } from '~/features/status/StatusPluginBar.tsx';
import { RepositoryPanel } from '~/features/repository/RepositoryPanel.tsx';
import { WorkspaceNoteDialog } from '~/features/workspace/WorkspaceNoteDialog.tsx';
import type { WorkspaceState } from '~/features/workspace/model/workspace-state.ts';
import { ToolbarButton } from '~/shared/ui/index.ts';
import { BackgroundDialog } from '~/features/terminal/BackgroundDialog.tsx';
import { TerminalViewport } from '~/features/terminal/TerminalViewport.tsx';
import '../features/terminal/workspace-terminal.css';

export const WorkspaceTerminal = observer(function WorkspaceTerminal({
  onManageStatusWidgets,
  onOpenWorkspaces,
  state,
  statusPlugins,
}: {
  onManageStatusWidgets: () => void;
  onOpenWorkspaces: () => void;
  state: WorkspaceState;
  statusPlugins: StatusPluginSnapshot[];
}) {
  const [repositoryOpen, setRepositoryOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [backgroundOpen, setBackgroundOpen] = useState(false);
  const [repositoryStatus, setRepositoryStatus] = useState<{
    branch?: string;
    changeCount: number;
    worktreeCount: number;
  }>({ changeCount: 0, worktreeCount: 0 });
  const [pathInsertion, setPathInsertion] = useState<{ entry: WorkspaceEntryDragData; token: number }>();
  const workspace = state.activeWorkspace;
  if (!workspace)
    return (
      <section className="empty-workbench">
        <h2>Workspace not found</h2>
        <p>This workspace is no longer registered on this Vampire server.</p>
      </section>
    );
  const terminal = [...workspace.terminals].sort((left, right) => left.index - right.index)[0];
  const backgroundCount = Math.max(0, workspace.terminals.length - 1);
  return (
    <section className={`workspace-terminal-layout${repositoryOpen ? ' repository-open' : ''}`}>
      <div className="terminal-sheet workspace-primary" aria-label={`Terminal for ${workspaceName(workspace)}`}>
        <div className="terminal-topbar">
          <StatusPluginBar plugins={statusPlugins} onManage={onManageStatusWidgets} />
          <header className="terminal-header">
            <ToolbarButton className="back-button" label="Open workspaces" onClick={onOpenWorkspaces}>
              <PanelLeft size={18} strokeWidth={1.8} aria-hidden="true" />
            </ToolbarButton>
            <div className="terminal-identity">
              <div className="terminal-identity-title">
                <strong>{workspaceName(workspace)}</strong>
                {repositoryStatus.branch || isWorktreeWorkspace(workspace) ? (
                  <span
                    className="branch-label"
                    title={`${repositoryStatus.branch ?? workspace.worktreeBranch ?? 'Git worktree'}${repositoryStatus.worktreeCount > 1 ? ` · ${repositoryStatus.worktreeCount} worktrees` : ''}`}
                  >
                    <GitBranch size={11} strokeWidth={1.9} aria-hidden="true" />
                    <span>{repositoryStatus.branch ?? workspace.worktreeBranch ?? 'Worktree'}</span>
                  </span>
                ) : null}
                {workspace.workspaceAvailable === false ? (
                  <span className="working-copy-missing" title="The working directory was removed outside Vampire">
                    Working copy missing
                  </span>
                ) : null}
              </div>
              <span title={workspace.cwd}>{workspace.cwd}</span>
            </div>
            <div className="terminal-controls">
              <div className="terminal-tools" role="group" aria-label="Terminal tools">
                <ToolbarButton
                  id="background-process-trigger"
                  className="background-button"
                  label={backgroundOpen ? 'Close background processes' : 'Open background processes'}
                  active={backgroundOpen}
                  aria-expanded={backgroundOpen}
                  aria-controls="background-process-panel"
                  onClick={() => setBackgroundOpen((open) => !open)}
                >
                  <Activity size={16} strokeWidth={1.8} aria-hidden="true" />
                  {backgroundCount > 0 ? <span>{backgroundCount > 99 ? '99+' : backgroundCount}</span> : null}
                </ToolbarButton>
                <ToolbarButton
                  className={`note-button${workspace.notePreview ? ' has-note' : ''}`}
                  label={
                    noteOpen
                      ? 'Close workspace note'
                      : workspace.notePreview
                        ? 'Open workspace note'
                        : 'Add workspace note'
                  }
                  active={noteOpen}
                  aria-expanded={noteOpen}
                  onClick={() => setNoteOpen((open) => !open)}
                >
                  <StickyNote size={16} strokeWidth={1.8} aria-hidden="true" />
                </ToolbarButton>
                <ToolbarButton
                  className="repository-button"
                  label={repositoryOpen ? 'Close repository' : 'Open repository'}
                  active={repositoryOpen}
                  aria-expanded={repositoryOpen}
                  onClick={() => setRepositoryOpen((open) => !open)}
                >
                  <ListTree size={16} strokeWidth={1.8} aria-hidden="true" />
                  {workspace.isGitRepository && repositoryStatus.changeCount > 0 ? (
                    <span aria-label={`${repositoryStatus.changeCount} changed files`}>
                      {repositoryStatus.changeCount > 99 ? '99+' : repositoryStatus.changeCount}
                    </span>
                  ) : null}
                </ToolbarButton>
              </div>
            </div>
          </header>
        </div>
        <div className="main-workspace-terminal" key={terminal?.id}>
          <TerminalViewport
            workspaceId={workspace.id}
            terminalId={terminal?.id}
            pathInsertion={pathInsertion}
            composerHistoryEnabled={state.composerHistorySettings.enabled}
            composerTemplate={workspace.composerTemplate}
            composerTemplateContext={{ workspace: { name: workspaceName(workspace), cwd: workspace.cwd } }}
            onInputActivity={(id, timestamp) => state.recordWorkspaceInput(id, timestamp)}
            onWorkspaceObserved={(id) => state.markWorkspaceObserved(id)}
            onOutputActivity={(id, active, timestamp) => state.recordWorkspaceOutput(id, active, timestamp, true)}
            onRepositoryStatus={(changeCount, worktreeCount, branch) =>
              setRepositoryStatus({ changeCount, worktreeCount, branch })
            }
            onRecordComposerPrompt={(id, prompt) => state.recordWorkspaceComposerPrompt(id, prompt)}
            onLoadComposerPrompts={state.loadWorkspaceComposerPrompts}
            onUploadFiles={async (dataTransfer) => {
              const selection = await uploadSelectionFromDataTransfer(dataTransfer);
              const api = new RepositoryClient(workspace.id);
              const paths: string[] = [];
              for (const candidate of selection.candidates) {
                const uploaded = await api.uploadFile(candidate.relativePath, candidate.file, 'rename');
                paths.push(uploaded.path);
              }
              return paths;
            }}
          />
        </div>
        <WorkspaceNoteDialog
          open={noteOpen}
          workspaceId={workspace.id}
          state={state}
          onClose={() => setNoteOpen(false)}
        />
        <BackgroundDialog
          open={backgroundOpen}
          workspaceId={workspace.id}
          state={state}
          onClose={() => setBackgroundOpen(false)}
        />
      </div>
      <RepositoryPanel
        key={workspace.id}
        open={repositoryOpen}
        workspaceId={workspace.id}
        onInsertPath={(entry) => {
          setPathInsertion({ entry, token: Date.now() });
          if (window.matchMedia('(max-width: 63.999rem)').matches) setRepositoryOpen(false);
        }}
        onClose={() => setRepositoryOpen(false)}
      />
    </section>
  );
});
