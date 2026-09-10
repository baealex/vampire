import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Ellipsis,
  File,
  Folder,
  FolderPlus,
  GitBranch,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Scissors,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { RepositoryClient } from '@vampire/lib/features/repository/api/client.ts';
import { uploadSelectionFromFiles } from '@vampire/lib/features/repository/api/upload.ts';
import { isPreviewableImage } from '@vampire/lib/features/repository/model/view.ts';
import {
  parseWorkspaceEntryDragEntries,
  WORKSPACE_ENTRY_DRAG_TYPE,
} from '@vampire/lib/shared/lib/workspace-entry-drag.ts';
import type {
  RepositoryCommitDiff,
  RepositoryDiff,
  RepositorySelection,
  WorkspaceEntryKind,
  WorkspaceFile,
} from '@vampire/lib/shared/contracts/repository.ts';
import { Button, Dialog, DropdownMenu, DropdownMenuItem, Input, Spinner, ToolbarButton } from '~/shared/ui/index.ts';
import { RepositoryWorkspaceState } from './model/repository-workspace-state.ts';
import './repository-panel.css';

type Tab = 'files' | 'changes' | 'commits' | 'branches';
const CodeEditor = lazy(() => import('~/shared/ui/CodeEditor.tsx').then((module) => ({ default: module.CodeEditor })));
type Entry = { kind: WorkspaceEntryKind; path: string };
function parent(path: string) {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}
function basename(path: string) {
  return path.slice(path.lastIndexOf('/') + 1);
}

export const RepositoryPanel = observer(function RepositoryPanel({
  onClose,
  onInsertPath,
  open,
  workspaceId,
}: {
  onClose: () => void;
  onInsertPath: (entry: Entry) => void;
  open: boolean;
  workspaceId: string;
}) {
  const openRef = useRef(open);
  openRef.current = open;
  const [state] = useState(() => new RepositoryWorkspaceState(workspaceId, { isOpen: () => openRef.current }));
  const [tab, setTab] = useState<Tab>('files');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedEntry, setSelectedEntry] = useState<Entry>();
  const [entryDialog, setEntryDialog] = useState<{
    action: 'file' | 'directory' | 'rename';
    directory: string;
    entry?: Entry;
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
    if (state.selection && window.matchMedia('(max-width: 63.999rem)').matches) onClose();
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
    selectedEntry?.kind === 'directory' ? selectedEntry.path : selectedEntry ? parent(selectedEntry.path) : '';
  const openEntryDialog = (
    action: 'file' | 'directory' | 'rename',
    targetDirectory = directory,
    targetEntry = selectedEntry
  ) => {
    const entry = action === 'rename' ? targetEntry : undefined;
    setEntryName(entry ? basename(entry.path) : '');
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
      <aside
        className={`repository-panel${open ? ' open' : ''}${rootDropActive ? ' root-drop-active' : ''}`}
        aria-label="Repository for workspace"
        aria-hidden={!open}
        inert={!open ? true : undefined}
        onDragOver={(event) => {
          if (event.target instanceof Element && event.target.closest('.tree-row-shell.root')) {
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
        <header className="repository-header">
          <GitBranch size={17} />
          <strong>{state.branch || 'Repository'}</strong>
          <ToolbarButton label="Refresh repository" onClick={() => void state.refresh()}>
            <RefreshCw size={16} />
          </ToolbarButton>
          <ToolbarButton label="Close workspace panel" onClick={onClose}>
            <X size={17} />
          </ToolbarButton>
        </header>
        <div className="repository-tabs" role="tablist">
          {(['files', 'changes'] as Tab[]).map((value) => (
            <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => setTab(value)}>
              {value === 'files' ? 'Explorer' : 'Git'}
              {value === 'changes' && state.changeCount ? <span>{state.changeCount}</span> : null}
            </button>
          ))}
        </div>
        {state.loading && !snapshot ? (
          <div className="repository-loading">
            <Spinner />
            Loading repository…
          </div>
        ) : state.errorMessage && !snapshot ? (
          <p className="repository-error" role="alert">
            {state.errorMessage}
          </p>
        ) : snapshot ? (
          <div className="repository-content">
            <div className="repository-toolbar">
              <Button size="sm" variant="ghost" onClick={() => openEntryDialog('file')}>
                <File size={14} />
                New file
              </Button>
              <Button size="sm" variant="ghost" onClick={() => openEntryDialog('directory')}>
                <FolderPlus size={14} />
                New folder
              </Button>
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
              <Button size="sm" variant="ghost" disabled={state.uploading} onClick={() => uploadInput.current?.click()}>
                <Upload size={14} />
                {state.uploading ? 'Adding…' : 'Add files'}
              </Button>
              {selectedEntry ? (
                <>
                  <Button size="sm" variant="ghost" onClick={() => openEntryDialog('rename')}>
                    <Pencil size={14} />
                    Rename
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => state.setClipboard('copy', [selectedEntry])}>
                    <Copy size={14} />
                    Copy
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => state.setClipboard('cut', [selectedEntry])}>
                    <Scissors size={14} />
                    Cut
                  </Button>
                  <Button
                    size="sm"
                    variant="danger-outline"
                    onClick={() => state.requestDelete(selectedEntry.path, selectedEntry.kind)}
                  >
                    <Trash2 size={14} />
                    Delete
                  </Button>
                </>
              ) : null}
              {state.clipboard ? (
                <Button size="sm" onClick={() => void state.pasteEntries(directory)}>
                  Paste {state.clipboard.entries.length}
                </Button>
              ) : null}
            </div>
            {state.uploadNotice ? (
              <p className={state.uploadNoticeKind === 'error' ? 'repository-error' : ''} role="status">
                {state.uploadNotice}
              </p>
            ) : null}
            {tab === 'files' ? (
              <RepositoryTree
                state={state}
                expanded={expanded}
                selected={selectedEntry}
                onSelect={setSelectedEntry}
                onToggle={toggleDirectory}
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
            ) : tab === 'changes' ? (
              <RepositoryChanges state={state} />
            ) : tab === 'commits' ? (
              <RepositoryCommits state={state} />
            ) : (
              <RepositoryBranches state={state} />
            )}
          </div>
        ) : null}
      </aside>
      {state.selection ? (
        <RepositoryViewer
          workspaceId={workspaceId}
          selection={state.selection}
          onClose={() => void state.closeViewer()}
          onEditFile={(path) => void state.editFile(path)}
          onRequestDiscardChange={(path) => state.requestDiscardChange(path)}
          onDirtyChange={state.markFileDirty}
          onSaved={state.handleFileSaved}
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

const RepositoryTree = observer(function RepositoryTree({
  expanded,
  onCreate,
  onInsertPath,
  onSelect,
  onToggle,
  onUpload,
  onUploadFolder,
  onUploadDrop,
  selected,
  state,
}: {
  expanded: Set<string>;
  onCreate: (action: 'file' | 'directory' | 'rename', directory: string, entry?: Entry) => void;
  onInsertPath: (entry: Entry) => void;
  onSelect: (entry: Entry) => void;
  onToggle: (path: string) => Promise<void>;
  onUpload: (directory: string) => void;
  onUploadFolder: (directory: string) => void;
  onUploadDrop: (files: FileList, directory: string) => Promise<void>;
  selected?: Entry;
  state: RepositoryWorkspaceState;
}) {
  const snapshot = state.snapshot!;
  const [menuKey, setMenuKey] = useState<string>();
  const [dropTarget, setDropTarget] = useState<string>();
  const rows = useMemo(
    () =>
      [
        ...snapshot.directories.map((path) => ({ kind: 'directory' as const, path })),
        ...snapshot.files.map((path) => ({ kind: 'file' as const, path })),
      ]
        .filter((entry) => {
          const ancestors = entry.path.split('/').slice(0, -1);
          return ancestors.every((_, index) => expanded.has(ancestors.slice(0, index + 1).join('/')));
        })
        .sort(
          (a, b) =>
            parent(a.path).localeCompare(parent(b.path)) ||
            Number(a.kind === 'file') - Number(b.kind === 'file') ||
            a.path.localeCompare(b.path)
        ),
    [expanded, snapshot.directories, snapshot.files]
  );
  const drop = async (event: React.DragEvent, targetDirectory: string) => {
    event.preventDefault();
    event.stopPropagation();
    setDropTarget(undefined);
    if (event.dataTransfer.files.length) await onUploadDrop(event.dataTransfer.files, targetDirectory);
    else {
      const entries = parseWorkspaceEntryDragEntries(event.dataTransfer.getData(WORKSPACE_ENTRY_DRAG_TYPE));
      for (const entry of entries ?? []) await state.moveEntry(entry.path, entry.kind, targetDirectory);
    }
    if (targetDirectory) {
      if (!expanded.has(targetDirectory)) await onToggle(targetDirectory);
      else await state.loadDirectory(targetDirectory);
      setDropTarget(undefined);
    }
  };
  const EntryMenu = ({ entry }: { entry: Entry }) => (
    <DropdownMenu
      align="end"
      open={menuKey === `${entry.kind}:${entry.path}`}
      onOpenChange={(open) => setMenuKey(open ? `${entry.kind}:${entry.path}` : undefined)}
      label={`Actions for ${entry.kind} ${basename(entry.path)}`}
      trigger={<Ellipsis size={15} />}
    >
      {entry.kind === 'directory' ? (
        <>
          <DropdownMenuItem onSelect={() => onCreate('file', entry.path)}>New file</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onCreate('directory', entry.path)}>New folder</DropdownMenuItem>
        </>
      ) : null}
      <DropdownMenuItem onSelect={() => onInsertPath(entry)}>Insert path into terminal</DropdownMenuItem>
      <DropdownMenuItem onSelect={() => onCreate('rename', parent(entry.path), entry)}>Rename</DropdownMenuItem>
      <DropdownMenuItem danger onSelect={() => state.requestDelete(entry.path, entry.kind)}>
        Delete
      </DropdownMenuItem>
    </DropdownMenu>
  );
  return (
    <div className="repository-list repository-tree">
      <div
        className={`tree-row-shell root${dropTarget === '' ? ' drop-target' : ''}`}
        onDragOver={(event) => {
          event.preventDefault();
          setDropTarget('');
        }}
        onDragLeave={() => setDropTarget(undefined)}
        onDrop={(event) => void drop(event, '')}
      >
        <button type="button" className="repository-root-row">
          Workspace root
        </button>
        <DropdownMenu align="end" label="Add inside workspace root" trigger={<Plus size={16} />}>
          <DropdownMenuItem onSelect={() => onCreate('file', '')}>New file</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onCreate('directory', '')}>New folder</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onUpload('')}>Upload files…</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onUploadFolder('')}>Upload folder…</DropdownMenuItem>
        </DropdownMenu>
      </div>
      {rows.map((entry) => {
        const key = `${entry.kind}:${entry.path}`;
        return (
          <div
            key={key}
            className={`tree-row-shell ${entry.kind}${dropTarget === entry.path ? ' drop-target' : ''}`}
            data-path={entry.path}
            onContextMenu={(event) => {
              event.preventDefault();
              onSelect(entry);
              setMenuKey(key);
            }}
            onDragOver={
              entry.kind === 'directory'
                ? (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setDropTarget(entry.path);
                  }
                : undefined
            }
            onDragLeave={() => setDropTarget(undefined)}
            onDrop={entry.kind === 'directory' ? (event) => void drop(event, entry.path) : undefined}
          >
            <button
              type="button"
              aria-label={`${entry.kind === 'directory' ? (expanded.has(entry.path) ? 'Collapse' : 'Expand') : 'Open'} ${entry.path}`}
              className={selected?.kind === entry.kind && selected.path === entry.path ? 'selected' : ''}
              style={{ paddingLeft: `${0.75 + entry.path.split('/').length * 0.8}rem` }}
              onClick={() => {
                onSelect(entry);
                if (entry.kind === 'directory') void onToggle(entry.path);
                else void state.editFile(entry.path);
              }}
              onKeyDown={(event) => {
                if (event.key === 'F2') {
                  event.preventDefault();
                  onCreate('rename', parent(entry.path), entry);
                } else if (event.key === 'Delete') {
                  event.preventDefault();
                  state.requestDelete(entry.path, entry.kind);
                } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
                  event.preventDefault();
                  state.setClipboard('copy', [entry]);
                } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'x') {
                  event.preventDefault();
                  state.setClipboard('cut', [entry]);
                } else if (
                  entry.kind === 'directory' &&
                  (event.ctrlKey || event.metaKey) &&
                  event.key.toLowerCase() === 'v'
                ) {
                  event.preventDefault();
                  void state
                    .pasteEntries(entry.path)
                    .then(() => (expanded.has(entry.path) ? state.loadDirectory(entry.path) : onToggle(entry.path)));
                }
              }}
            >
              {entry.kind === 'directory' ? (
                expanded.has(entry.path) ? (
                  <ChevronDown size={14} />
                ) : (
                  <ChevronRight size={14} />
                )
              ) : (
                <span />
              )}
              {entry.kind === 'directory' ? <Folder size={15} /> : <File size={15} />}
              <span>{basename(entry.path)}</span>
            </button>
            <EntryMenu entry={entry} />
          </div>
        );
      })}
    </div>
  );
});

const RepositoryChanges = observer(function RepositoryChanges({ state }: { state: RepositoryWorkspaceState }) {
  const changes = state.snapshot?.changes ?? [];
  return (
    <div className="repository-list">
      {changes.length === 0 ? (
        <p className="repository-empty">The working tree is clean.</p>
      ) : (
        changes.map((change) => (
          <div className="repository-change" key={`${change.status}:${change.path}`}>
            <button
              type="button"
              aria-label={`Open diff for ${change.path}`}
              onClick={() => void state.selectItem({ kind: 'diff', path: change.path })}
            >
              <span className="change-status">{change.status}</span>
              <span>{change.path}</span>
            </button>
            <ToolbarButton
              label={`Discard changes for ${change.path}`}
              onClick={() => state.requestDiscardChange(change)}
            >
              <Trash2 size={14} />
            </ToolbarButton>
          </div>
        ))
      )}
    </div>
  );
});
const RepositoryCommits = observer(function RepositoryCommits({ state }: { state: RepositoryWorkspaceState }) {
  const git = state.snapshot?.git;
  if (!git) return <p className="repository-empty">This is not a Git repository.</p>;
  return (
    <div className="repository-list">
      {git.commits.map((commit) => (
        <button
          key={commit.hash}
          type="button"
          onClick={() => void state.selectItem({ kind: 'commit', path: commit.hash })}
        >
          <code>{commit.shortHash}</code>
          <span>
            <strong>{commit.subject}</strong>
            <small>
              {commit.authorName} · {new Date(commit.authoredAt).toLocaleString()} · +{commit.stats.additions} −
              {commit.stats.deletions}
            </small>
          </span>
        </button>
      ))}
      {git.hasMoreCommits ? (
        <Button block variant="ghost" disabled={state.loadingMoreCommits} onClick={() => void state.loadMoreCommits()}>
          {state.loadingMoreCommits ? 'Loading…' : 'Load older commits'}
        </Button>
      ) : null}
    </div>
  );
});
const RepositoryBranches = observer(function RepositoryBranches({ state }: { state: RepositoryWorkspaceState }) {
  const git = state.snapshot?.git;
  if (!git) return <p className="repository-empty">This is not a Git repository.</p>;
  return (
    <div className="repository-list">
      {git.branches.map((branch) => (
        <div className="repository-branch" key={branch.name}>
          {branch.current ? <Check size={14} /> : <GitBranch size={14} />}
          <span>
            <strong>{branch.name}</strong>
            <small>{branch.worktreePath ?? branch.head ?? 'No commits'}</small>
          </span>
          {!branch.current && !branch.worktreePath ? (
            <ToolbarButton label={`Delete branch ${branch.name}`} onClick={() => state.requestDeleteBranch(branch)}>
              <Trash2 size={14} />
            </ToolbarButton>
          ) : null}
        </div>
      ))}
    </div>
  );
});

function RepositoryViewer({
  onClose,
  onDirtyChange,
  onEditFile,
  onRequestDiscardChange,
  onSaved,
  selection,
  workspaceId,
}: {
  onClose: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onEditFile: (path: string) => void;
  onRequestDiscardChange: (path: string) => void;
  onSaved: (file: WorkspaceFile, dirty?: boolean) => void;
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
  const contentRef = useRef(content);
  contentRef.current = content;
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setFile(undefined);
    setDiff(undefined);
    setCommit(undefined);
    const request =
      selection.kind === 'file'
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
  }, [api, selection.kind, selection.path]);
  const save = async () => {
    if (!file || saving) return;
    setSaving(true);
    setError('');
    try {
      const saved = await api.updateFile(file.path, contentRef.current, file.version);
      setFile(saved);
      const dirty = contentRef.current !== saved.content;
      onDirtyChange(dirty);
      onSaved(saved, dirty);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The file could not be saved.');
    } finally {
      setSaving(false);
    }
  };
  const image = selection.kind === 'file' && isPreviewableImage(selection.path);
  const documentKind = selection.kind === 'diff' ? 'Diff' : selection.kind === 'commit' ? 'Commit' : 'File';
  return (
    <section className="repository-viewer" aria-label={`${documentKind} for ${selection.path}`}>
      <header>
        <strong title={selection.path}>{selection.path}</strong>
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
          aria-label={`Loading ${selection.kind === 'file' ? 'file' : 'changes'}: ${basename(selection.path)}`}
        >
          <span className="document-opening__spinner" aria-hidden="true" />
          <span>
            Loading {selection.kind === 'file' ? 'file' : 'changes'} <code>{basename(selection.path)}</code>
          </span>
        </div>
      ) : image ? (
        <img className="repository-image" src={api.mediaUrl(selection.path)} alt={selection.path} />
      ) : file ? (
        <div className="repository-code-editor" aria-label={`Edit ${file.path}`}>
          <Suspense fallback={<div className="repository-loading">Loading editor…</div>}>
            <CodeEditor
              label={`Editor for ${file.path}`}
              value={content}
              onChange={(next) => {
                setContent(next);
                contentRef.current = next;
                setError('');
                onDirtyChange(next !== file.content);
              }}
            />
          </Suspense>
          <footer>
            <span role="status">
              {saving ? 'Saving…' : error ? 'Save failed' : content !== file.content ? 'Unsaved changes' : 'Saved'}
            </span>
            <Button
              size="sm"
              variant="primary"
              onClick={() => void save()}
              disabled={saving || content === file.content}
            >
              <Save size={15} />
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </footer>
          {error ? (
            <p className="editor-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      ) : (
        <pre>
          {diff?.sections.map((section) => section.patch).join('\n') || commit?.patch || 'No text diff available.'}
        </pre>
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
