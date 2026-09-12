import { RepositoryClient } from '@vampire/lib/features/repository/api/client.ts';
import { uploadSelectionFromFiles } from '@vampire/lib/features/repository/api/upload.ts';
import {
  isPreviewableImage,
  repositoryNavigationPaths,
  repositorySelectionLabel,
  repositoryViewerEmptyState,
  repositoryViewerSections,
} from '@vampire/lib/features/repository/model/view.ts';
import type {
  RepositoryCommitDiff,
  RepositoryDiff,
  RepositorySelection,
  WorkspaceFile,
} from '@vampire/lib/shared/contracts/repository.ts';
import { ChevronLeft, ChevronRight, Pencil, RefreshCw, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  Dialog,
  Input,
  PanelState,
  Spinner,
  ToolbarButton,
  WorkspacePanelHeader,
  WorkspaceSidePanel,
} from '~/shared/ui/index.ts';
import { RepositoryWorkspaceState } from './model/repository-workspace-state.ts';
import { RepositoryDiffDocument } from './RepositoryDiffDocument.tsx';
import { RepositoryExplorer } from './RepositoryExplorer.tsx';
import { RepositoryGitPanel, type RepositoryGitView } from './RepositoryGitPanel.tsx';
import { type RepositoryEntry, repositoryBasename, repositoryParentPath } from './repository-path.ts';
import './repository-panel.css';

type Tab = 'files' | 'git';
const CodeEditor = lazy(() => import('~/shared/ui/CodeEditor.tsx').then((module) => ({ default: module.CodeEditor })));

export const RepositoryPanel = observer(function RepositoryPanel({
  onClose,
  onInsertPath,
  open,
  projectName,
  projectPath,
  workspaceId,
}: {
  onClose: () => void;
  onInsertPath: (entry: RepositoryEntry) => void;
  open: boolean;
  projectName: string;
  projectPath: string;
  workspaceId: string;
}) {
  const openRef = useRef(open);
  openRef.current = open;
  const [state] = useState(() => new RepositoryWorkspaceState(workspaceId, { isOpen: () => openRef.current }));
  const [tab, setTab] = useState<Tab>('files');
  const [gitView, setGitView] = useState<RepositoryGitView>('changes');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedEntry, setSelectedEntry] = useState<RepositoryEntry>();
  const [entryDialog, setEntryDialog] = useState<{
    action: 'file' | 'directory' | 'rename';
    directory: string;
    entry?: RepositoryEntry;
  }>();
  const [entryName, setEntryName] = useState('');
  const [entryError, setEntryError] = useState('');
  const [rootDropActive, setRootDropActive] = useState(false);
  const disposeTimer = useRef<number | undefined>(undefined);
  const uploadInput = useRef<HTMLInputElement>(null);
  const uploadFolderInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (disposeTimer.current !== undefined) {
      window.clearTimeout(disposeTimer.current);
      disposeTimer.current = undefined;
    }
    const refresh = () => {
      if (!document.hidden && openRef.current) void state.refresh();
    };
    document.addEventListener('visibilitychange', refresh);
    return () => {
      document.removeEventListener('visibilitychange', refresh);
      // StrictMode replays effects in development. Defer irreversible disposal
      // so the replayed setup can cancel it while a real unmount still cleans up.
      disposeTimer.current = window.setTimeout(() => {
        state.dispose();
        disposeTimer.current = undefined;
      });
    };
  }, [state]);
  useEffect(() => {
    if (open) void state.refresh(true);
  }, [open, state]);
  useEffect(() => {
    if (state.selection && window.matchMedia('(max-width: 31.999rem)').matches) onClose();
  }, [onClose, state.selection]);
  const toggleDirectory = async (path: string) => {
    if (expanded.has(path)) {
      setExpanded((current) => {
        const next = new Set(current);
        next.delete(path);
        return next;
      });
      state.collapseDirectory(path);
    } else {
      await state.loadDirectory(path);
      setExpanded((current) => new Set(current).add(path));
    }
  };
  const directory =
    selectedEntry?.kind === 'directory'
      ? selectedEntry.path
      : selectedEntry
        ? repositoryParentPath(selectedEntry.path)
        : '';
  const openEntryDialog = (
    action: 'file' | 'directory' | 'rename',
    targetDirectory = directory,
    targetEntry = selectedEntry,
  ) => {
    const entry = action === 'rename' ? targetEntry : undefined;
    setEntryName(entry ? repositoryBasename(entry.path) : '');
    setEntryError('');
    setEntryDialog({ action, directory: targetDirectory, entry });
  };
  const submitEntry = async () => {
    if (!entryDialog || !entryName.trim()) return;
    try {
      if (entryDialog.action === 'file') await state.createFile(entryDialog.directory, entryName.trim());
      else if (entryDialog.action === 'directory') await state.createDirectory(entryDialog.directory, entryName.trim());
      else if (entryDialog.entry) {
        const result = await state.renameEntry(entryDialog.entry.path, entryDialog.entry.kind, entryName.trim());
        setSelectedEntry({ kind: entryDialog.entry.kind, path: result.path });
      }
      setEntryDialog(undefined);
    } catch (cause) {
      setEntryError(cause instanceof Error ? cause.message : 'The repository entry could not be changed.');
    }
  };
  const upload = async (files: FileList | null, targetDirectory = directory) => {
    if (!files?.length) return;
    try {
      await state.uploadFiles(uploadSelectionFromFiles(files), targetDirectory);
    } catch (cause) {
      state.reportUploadError(cause instanceof Error ? cause.message : 'The files could not be added.');
    }
  };
  const snapshot = state.snapshot;
  return (
    <>
      <WorkspaceSidePanel
        open={open}
        className={`repository-panel${open ? ' open' : ''}${rootDropActive ? ' root-drop-active' : ''}`}
        aria-label={`${snapshot?.isGitRepository === false ? 'Files' : 'Repository'} for ${projectName}`}
        onDragOver={(event) => {
          if (event.target instanceof Element && event.target.closest('[data-repository-root]')) {
            event.preventDefault();
            setRootDropActive(true);
          }
        }}
        onDragLeave={() => setRootDropActive(false)}
        onDrop={(event) => {
          setRootDropActive(false);
          if (event.defaultPrevented) return;
        }}
      >
        <WorkspacePanelHeader
          title="Workspace"
          subtitle={projectName}
          subtitleTitle={projectPath}
          subtitleMonospace
          close={onClose}
          closeLabel="Close workspace panel"
          actions={
            <ToolbarButton
              className={state.loading ? 'repository-refresh spinning' : 'repository-refresh'}
              label="Refresh workspace and Git"
              disabled={state.loading}
              onClick={() => void state.refresh()}
            >
              <RefreshCw size={17} strokeWidth={1.8} aria-hidden="true" />
            </ToolbarButton>
          }
        />
        {snapshot?.isGitRepository !== false ? (
          <div className="repository-tabs" role="tablist" aria-label="Repository view">
            <button type="button" role="tab" aria-selected={tab === 'files'} onClick={() => setTab('files')}>
              Explorer
            </button>
            <button type="button" role="tab" aria-selected={tab === 'git'} onClick={() => setTab('git')}>
              Git
            </button>
          </div>
        ) : null}
        <input
          hidden
          multiple
          ref={uploadInput}
          type="file"
          onChange={(event) => {
            void upload(event.currentTarget.files);
            event.currentTarget.value = '';
          }}
        />
        <input
          hidden
          multiple
          ref={(element) => {
            uploadFolderInput.current = element;
            element?.setAttribute('webkitdirectory', '');
          }}
          type="file"
          onChange={(event) => {
            void upload(event.currentTarget.files);
            event.currentTarget.value = '';
          }}
        />
        {state.loading && !snapshot ? (
          <PanelState loading>Loading repository…</PanelState>
        ) : state.errorMessage && !snapshot ? (
          <PanelState error>{state.errorMessage}</PanelState>
        ) : snapshot ? (
          <div className="repository-content">
            {snapshot.gitError ? (
              <p className="repository-notice repository-error" role="status">
                {snapshot.gitError}
              </p>
            ) : null}
            {state.uploadNotice ? (
              <p
                className={`repository-notice${state.uploadNoticeKind === 'error' ? ' repository-error' : ''}`}
                role="status"
              >
                {state.uploadNotice}
              </p>
            ) : null}
            {tab === 'files' || !snapshot.git ? (
              <RepositoryExplorer
                state={state}
                expanded={expanded}
                projectName={projectName}
                projectPath={projectPath}
                selected={selectedEntry}
                onSelect={setSelectedEntry}
                onToggle={toggleDirectory}
                onCollapseAll={() => {
                  for (const path of expanded) state.collapseDirectory(path);
                  setExpanded(new Set());
                }}
                onCreate={(action, targetDirectory, entry) => openEntryDialog(action, targetDirectory, entry)}
                onUpload={(targetDirectory) => {
                  setSelectedEntry(targetDirectory ? { kind: 'directory', path: targetDirectory } : undefined);
                  uploadInput.current?.click();
                }}
                onUploadFolder={(targetDirectory) => {
                  setSelectedEntry(targetDirectory ? { kind: 'directory', path: targetDirectory } : undefined);
                  uploadFolderInput.current?.click();
                }}
                onInsertPath={onInsertPath}
                onUploadDrop={(files, targetDirectory) => upload(files, targetDirectory)}
              />
            ) : (
              <RepositoryGitPanel state={state} view={gitView} onViewChange={setGitView} />
            )}
          </div>
        ) : null}
      </WorkspaceSidePanel>
      {state.selection ? (
        <RepositoryViewer
          workspaceId={workspaceId}
          selection={state.selection}
          onClose={() => void state.closeViewer()}
          onEditFile={(path) => void state.editFile(path)}
          onRequestDiscardChange={(path) => state.requestDiscardChange(path)}
          onDirtyChange={state.markFileDirty}
          onSaved={state.handleFileSaved}
          navigationPaths={repositoryNavigationPaths(state.selection, snapshot)}
          onNavigate={(selection) => void state.selectItem(selection)}
        />
      ) : null}
      {entryDialog ? (
        <Dialog
          open
          title={
            entryDialog.action === 'rename' ? 'Rename entry' : entryDialog.action === 'file' ? 'New file' : 'New folder'
          }
          onClose={() => setEntryDialog(undefined)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setEntryDialog(undefined)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={() => void submitEntry()}>
                Save
              </Button>
            </>
          }
        >
          <Input
            value={entryName}
            onChange={(event) => setEntryName(event.currentTarget.value)}
            autoFocus
            aria-label={
              entryDialog.action === 'rename'
                ? `Rename ${entryDialog.entry?.kind ?? 'entry'}`
                : `New ${entryDialog.action === 'directory' ? 'folder' : 'file'} name`
            }
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void submitEntry();
              }
            }}
          />
          {entryError ? <p role="alert">{entryError}</p> : null}
        </Dialog>
      ) : null}
      <RepositoryConfirmations state={state} />
    </>
  );
});

function RepositoryViewer({
  onClose,
  onDirtyChange,
  onEditFile,
  onRequestDiscardChange,
  onSaved,
  navigationPaths,
  onNavigate,
  selection,
  workspaceId,
}: {
  onClose: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onEditFile: (path: string) => void;
  onRequestDiscardChange: (path: string) => void;
  onSaved: (file: WorkspaceFile, dirty?: boolean) => void;
  navigationPaths: string[];
  onNavigate: (selection: RepositorySelection) => void;
  selection: RepositorySelection;
  workspaceId: string;
}) {
  const api = useMemo(() => new RepositoryClient(workspaceId), [workspaceId]);
  const [file, setFile] = useState<WorkspaceFile>();
  const [diff, setDiff] = useState<RepositoryDiff>();
  const [commit, setCommit] = useState<RepositoryCommitDiff>();
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const failedContentRef = useRef<string | undefined>(undefined);
  const contentRef = useRef(content);
  contentRef.current = content;
  const image = selection.kind !== 'commit' && isPreviewableImage(selection.path);
  const parsedSections = useMemo(() => repositoryViewerSections(diff, commit), [diff, commit]);
  const navigationIndex = navigationPaths.indexOf(selection.path);
  const previousPath = navigationIndex > 0 ? navigationPaths[navigationIndex - 1] : undefined;
  const nextPath =
    navigationIndex >= 0 && navigationIndex < navigationPaths.length - 1
      ? navigationPaths[navigationIndex + 1]
      : undefined;
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setFile(undefined);
    setDiff(undefined);
    setCommit(undefined);
    const request = image
      ? Promise.resolve()
      : selection.kind === 'file'
        ? api.readFile(selection.path, controller.signal).then((value) => {
            setFile(value);
            setContent(value.content);
            contentRef.current = value.content;
          })
        : selection.kind === 'diff'
          ? api.readDiff(selection.path, controller.signal).then(setDiff)
          : api.readCommit(selection.path, controller.signal).then(setCommit);
    void request
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Unable to open this item.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [api, image, selection.kind, selection.path]);
  useEffect(() => {
    if (!file || saving || content === file.content || failedContentRef.current === content) return;
    const timer = window.setTimeout(() => {
      const requestedContent = contentRef.current;
      setSaving(true);
      setError('');
      void api
        .updateFile(file.path, requestedContent, file.version)
        .then((saved) => {
          failedContentRef.current = undefined;
          setFile(saved);
          const dirty = contentRef.current !== saved.content;
          onDirtyChange(dirty);
          onSaved(saved, dirty);
        })
        .catch((cause) => {
          failedContentRef.current = requestedContent;
          setError(cause instanceof Error ? cause.message : 'The file could not be saved.');
        })
        .finally(() => setSaving(false));
    }, 600);
    return () => window.clearTimeout(timer);
  }, [api, content, file, onDirtyChange, onSaved, saving]);
  const documentKind = repositorySelectionLabel(selection.kind);
  const emptyState = repositoryViewerEmptyState(selection.kind);
  return (
    <section className="repository-viewer" aria-label={`${documentKind} for ${selection.path}`}>
      <header>
        <span className="document-kind">{documentKind}</span>
        <strong title={selection.path}>{selection.path}</strong>
        <span className="repository-mobile-navigation">
          <ToolbarButton
            label={`Open previous ${documentKind.toLowerCase()}`}
            disabled={!previousPath}
            onClick={() => previousPath && onNavigate({ kind: selection.kind, path: previousPath })}
          >
            <ChevronLeft size={17} />
          </ToolbarButton>
          <ToolbarButton
            label={`Open next ${documentKind.toLowerCase()}`}
            disabled={!nextPath}
            onClick={() => nextPath && onNavigate({ kind: selection.kind, path: nextPath })}
          >
            <ChevronRight size={17} />
          </ToolbarButton>
        </span>
        {selection.kind === 'diff' ? (
          <>
            <ToolbarButton
              label={`Edit ${selection.path}`}
              title="Edit file"
              onClick={() => onEditFile(selection.path)}
            >
              <Pencil size={16} />
            </ToolbarButton>
            <ToolbarButton
              label={`Discard changes for ${selection.path}`}
              title="Discard changes"
              onClick={() => onRequestDiscardChange(selection.path)}
            >
              <RefreshCw size={16} />
            </ToolbarButton>
          </>
        ) : null}
        <ToolbarButton label="Close file and return to terminal" onClick={onClose}>
          <X size={17} />
        </ToolbarButton>
      </header>
      {loading ? (
        <div
          className="document-opening"
          role="status"
          aria-label={`Loading ${selection.kind === 'file' ? 'file' : 'changes'}: ${repositoryBasename(selection.path)}`}
        >
          <span className="document-opening__spinner" aria-hidden="true" />
          <span>
            Loading {selection.kind === 'file' ? 'file' : 'changes'} <code>{repositoryBasename(selection.path)}</code>
          </span>
        </div>
      ) : image ? (
        <div className="image-document">
          <img className="repository-image" src={api.mediaUrl(selection.path)} alt={selection.path} />
        </div>
      ) : file ? (
        <div className="repository-code-editor" aria-label={`Edit ${file.path}`}>
          <Suspense fallback={<PanelState loading>Loading editor…</PanelState>}>
            <CodeEditor
              label={`Editor for ${file.path}`}
              path={file.path}
              value={content}
              onChange={(next) => {
                setContent(next);
                contentRef.current = next;
                failedContentRef.current = undefined;
                setError('');
                onDirtyChange(next !== file.content);
              }}
            />
          </Suspense>
          <footer>
            <span role="status">
              {saving
                ? 'Saving…'
                : error
                  ? 'Auto-save failed'
                  : content !== file.content
                    ? 'Waiting to save…'
                    : 'Saved'}
            </span>
          </footer>
          {error ? (
            <p className="editor-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      ) : parsedSections.length > 0 ? (
        <RepositoryDiffDocument key={`${selection.kind}:${selection.path}`} sections={parsedSections} />
      ) : (
        <div className="viewer-state">
          <div>
            <strong>{emptyState.title}</strong>
            <p>{emptyState.description}</p>
          </div>
        </div>
      )}
      {error && !file ? (
        <p className="editor-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

const RepositoryConfirmations = observer(function RepositoryConfirmations({
  state,
}: {
  state: RepositoryWorkspaceState;
}) {
  return (
    <>
      {state.discardChangesPrompt ? (
        <Dialog
          open
          role="alertdialog"
          title="Discard unsaved changes?"
          onClose={() => state.resolveDiscardChanges(false)}
          footer={
            <>
              <Button onClick={() => state.resolveDiscardChanges(false)}>Cancel</Button>
              <Button variant="danger" onClick={() => state.resolveDiscardChanges(true)}>
                Discard
              </Button>
            </>
          }
        >
          <p>The open file has unsaved changes.</p>
        </Dialog>
      ) : null}
      {state.discardTarget ? (
        <Dialog
          open
          role="alertdialog"
          title={state.discardChangeTitle(state.discardTarget)}
          onClose={() => {
            state.discardTarget = undefined;
          }}
          footer={
            <>
              <Button
                onClick={() => {
                  state.discardTarget = undefined;
                }}
              >
                Cancel
              </Button>
              <Button variant="danger" disabled={state.discarding} onClick={() => void state.confirmDiscardChange()}>
                {state.discarding
                  ? 'Discarding…'
                  : state.discardTarget.status === '??'
                    ? 'Delete file'
                    : 'Discard changes'}
              </Button>
            </>
          }
        >
          <p>{state.discardChangeDescription(state.discardTarget)}</p>
        </Dialog>
      ) : null}
      {state.deleteTargets.length ? (
        <Dialog
          open
          role="alertdialog"
          title="Delete repository entry?"
          onClose={() => {
            state.deleteTargets = [];
          }}
          footer={
            <>
              <Button
                onClick={() => {
                  state.deleteTargets = [];
                }}
              >
                Cancel
              </Button>
              <Button variant="danger" onClick={() => void state.confirmDelete()}>
                {state.deleteTargets.length === 1 && state.deleteTargets[0]?.kind === 'file'
                  ? 'Delete file'
                  : 'Delete permanently'}
              </Button>
            </>
          }
        >
          <p>{state.deleteDescription(state.deleteTargets)}</p>
        </Dialog>
      ) : null}
      {state.branchDeleteTarget ? (
        <Dialog
          open
          role="alertdialog"
          title="Delete branch?"
          onClose={() => {
            state.branchDeleteTarget = undefined;
          }}
          footer={
            <>
              <Button
                onClick={() => {
                  state.branchDeleteTarget = undefined;
                }}
              >
                Cancel
              </Button>
              <Button variant="danger" disabled={state.deletingBranch} onClick={() => void state.confirmDeleteBranch()}>
                {state.deletingBranch ? 'Deleting…' : 'Delete branch'}
              </Button>
            </>
          }
        >
          <p>Delete branch “{state.branchDeleteTarget.name}”? Commits not reachable elsewhere may be lost.</p>
        </Dialog>
      ) : null}
      {state.uploadConflicts.length ? (
        <Dialog
          open
          role="alertdialog"
          title={`${state.uploadConflicts.length} ${state.uploadConflicts.length === 1 ? 'file' : 'files'} already ${state.uploadConflicts.length === 1 ? 'exists' : 'exist'}`}
          onClose={() => void state.resolveUploadConflicts('skip')}
          footer={
            <>
              <Button onClick={() => void state.resolveUploadConflicts('skip')}>Skip</Button>
              <Button onClick={() => void state.resolveUploadConflicts('rename')}>Keep both</Button>
              <Button variant="danger" onClick={() => void state.resolveUploadConflicts('overwrite')}>
                Replace
              </Button>
            </>
          }
        >
          <p>
            {state.uploadConflicts.length} file{state.uploadConflicts.length === 1 ? '' : 's'} already exist in this
            folder.
          </p>
        </Dialog>
      ) : null}
      {state.moveConflict ? (
        <Dialog
          open
          role="alertdialog"
          title="An item already exists"
          onClose={() => void state.resolveMoveConflict('cancel')}
          footer={<Button onClick={() => void state.resolveMoveConflict('rename')}>Keep both</Button>}
        >
          <p>A repository entry with that name already exists.</p>
        </Dialog>
      ) : null}
    </>
  );
});
