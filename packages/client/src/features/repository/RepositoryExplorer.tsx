import { buildChangeKindMap, buildVisibleFileTree } from '@vampire/lib/features/repository/model/view.ts';
import {
  parseWorkspaceEntryDragEntries,
  WORKSPACE_ENTRY_DRAG_TYPE,
} from '@vampire/lib/shared/lib/workspace-entry-drag.ts';
import {
  ChevronDown,
  ChevronRight,
  Ellipsis,
  File,
  FileAudio,
  FileCode,
  FileImage,
  FileText,
  FileVideo,
  Folder,
  FolderOpen,
  Plus,
} from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useMemo, useState } from 'react';
import { DropdownMenu, DropdownMenuItem } from '~/shared/ui/index.ts';
import type { RepositoryWorkspaceState } from './model/repository-workspace-state.ts';
import { RepositoryVirtualList } from './RepositoryVirtualList.tsx';
import styles from './repository-explorer.module.css';
import {
  type RepositoryEntry,
  repositoryBasename,
  repositoryFileCategory,
  repositoryParentPath,
} from './repository-path.ts';

const entryKey = (entry: RepositoryEntry) => `${entry.kind}:${entry.path}`;
const rootMenuKey = '__repository-root-menu__';

function RepositoryFileIcon({ path }: { path: string }) {
  const category = repositoryFileCategory(path);
  if (category === 'image') return <FileImage size={15} aria-hidden="true" />;
  if (category === 'code') return <FileCode size={15} aria-hidden="true" />;
  if (category === 'document') return <FileText size={15} aria-hidden="true" />;
  if (category === 'audio') return <FileAudio size={15} aria-hidden="true" />;
  if (category === 'video') return <FileVideo size={15} aria-hidden="true" />;
  return <File size={15} aria-hidden="true" />;
}

export const RepositoryExplorer = observer(function RepositoryExplorer({
  expanded,
  onCreate,
  onCollapseAll,
  onInsertPath,
  onSelect,
  onToggle,
  onUpload,
  onUploadFolder,
  onUploadDrop,
  projectName,
  projectPath,
  selected,
  state,
}: {
  expanded: Set<string>;
  onCreate: (action: 'file' | 'directory' | 'rename', directory: string, entry?: RepositoryEntry) => void;
  onCollapseAll: () => void;
  onInsertPath: (entry: RepositoryEntry) => void;
  onSelect: (entry: RepositoryEntry) => void;
  onToggle: (path: string) => Promise<void>;
  onUpload: (directory: string) => void;
  onUploadFolder: (directory: string) => void;
  onUploadDrop: (files: FileList, directory: string) => Promise<void>;
  projectName: string;
  projectPath: string;
  selected?: RepositoryEntry;
  state: RepositoryWorkspaceState;
}) {
  const snapshot = state.snapshot!;
  const [menuKey, setMenuKey] = useState<string>();
  const [dropTarget, setDropTarget] = useState<string>();
  const [rootExpanded, setRootExpanded] = useState(true);
  const rows = useMemo(
    () => buildVisibleFileTree(snapshot.files, [...expanded], snapshot.directories),
    [expanded, snapshot.directories, snapshot.files],
  );
  const changeKinds = useMemo(() => buildChangeKindMap(snapshot.changes), [snapshot.changes]);
  const ignoredPaths = useMemo(() => new Set(snapshot.ignored), [snapshot.ignored]);

  const isGitIgnored = (path: string) => {
    let candidate = path;
    while (candidate) {
      if (ignoredPaths.has(candidate)) return true;
      const separator = candidate.lastIndexOf('/');
      candidate = separator < 0 ? '' : candidate.slice(0, separator);
    }
    return false;
  };

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

  const renderEntryMenu = (entry: RepositoryEntry) => {
    const key = `${entry.kind}:${entry.path}`;
    const label = `Actions for ${entry.kind} ${repositoryBasename(entry.path)}`;
    if (menuKey !== key) {
      return (
        <button type="button" className={styles.menuTrigger} aria-label={label} onClick={() => setMenuKey(key)}>
          <Ellipsis size={15} />
        </button>
      );
    }
    return (
      <DropdownMenu
        align="end"
        open
        onOpenChange={(open) => setMenuKey((current) => (open ? key : current === key ? undefined : current))}
        label={label}
        trigger={<Ellipsis size={15} />}
      >
        {entry.kind === 'directory' ? (
          <>
            <DropdownMenuItem onSelect={() => onCreate('file', entry.path)}>New file</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onCreate('directory', entry.path)}>New folder</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onUpload(entry.path)}>Upload files…</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onUploadFolder(entry.path)}>Upload folder…</DropdownMenuItem>
            {state.clipboard ? (
              <DropdownMenuItem onSelect={() => void state.pasteEntries(entry.path)}>Paste</DropdownMenuItem>
            ) : null}
          </>
        ) : null}
        <DropdownMenuItem onSelect={() => onInsertPath(entry)}>Insert path into terminal</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => state.setClipboard('copy', [entry])}>Copy</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => state.setClipboard('cut', [entry])}>Cut</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onCreate('rename', repositoryParentPath(entry.path), entry)}>
          Rename
        </DropdownMenuItem>
        <DropdownMenuItem danger onSelect={() => state.requestDelete(entry.path, entry.kind)}>
          Delete
        </DropdownMenuItem>
      </DropdownMenu>
    );
  };

  return (
    <div className={styles.list}>
      <div
        className={`${styles.row} ${styles.root}${dropTarget === '' ? ` ${styles.dropTarget}` : ''}`}
        data-repository-root
        onDragOver={(event) => {
          event.preventDefault();
          setDropTarget('');
        }}
        onDragLeave={() => setDropTarget(undefined)}
        onDrop={(event) => void drop(event, '')}
      >
        <button
          type="button"
          className={styles.rootButton}
          aria-expanded={rootExpanded}
          aria-label={`${rootExpanded ? 'Collapse' : 'Expand'} ${projectName} workspace root`}
          onClick={() => {
            setRootExpanded((current) => {
              if (current) onCollapseAll();
              return !current;
            });
          }}
        >
          {rootExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {rootExpanded ? <FolderOpen size={15} /> : <Folder size={15} />}
          <span title={projectPath}>{projectName}</span>
        </button>
        <div className={`${styles.actions} ${styles.rootActions}`}>
          <DropdownMenu
            align="end"
            open={menuKey === rootMenuKey}
            onOpenChange={(open) =>
              setMenuKey((current) => (open ? rootMenuKey : current === rootMenuKey ? undefined : current))
            }
            label="Add inside workspace root"
            trigger={<Plus size={16} />}
          >
            <DropdownMenuItem onSelect={() => onCreate('file', '')}>New file</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onCreate('directory', '')}>New folder</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onUpload('')}>Upload files…</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onUploadFolder('')}>Upload folder…</DropdownMenuItem>
            {state.clipboard ? (
              <DropdownMenuItem onSelect={() => void state.pasteEntries('')}>Paste</DropdownMenuItem>
            ) : null}
          </DropdownMenu>
        </div>
      </div>
      {rootExpanded ? (
        <RepositoryVirtualList
          items={rows}
          itemKey={entryKey}
          label="Repository files"
          estimateSize={33}
          pinnedKey={menuKey}
          renderItem={(entry) => {
            const key = `${entry.kind}:${entry.path}`;
            const selectedRow = selected?.kind === entry.kind && selected.path === entry.path;
            const changeKind = changeKinds.get(entry.path);
            return (
              <div
                key={key}
                className={`${styles.row}${selectedRow ? ` ${styles.selected}` : ''}${isGitIgnored(entry.path) ? ` ${styles.ignored}` : ''}${dropTarget === entry.path ? ` ${styles.dropTarget}` : ''}`}
                data-change-kind={changeKind}
                data-kind={entry.kind}
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
                  style={{ paddingLeft: `${1.37 + entry.depth * 0.72}rem` }}
                  onClick={() => {
                    onSelect(entry);
                    if (entry.kind === 'directory') void onToggle(entry.path);
                    else void state.editFile(entry.path);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'F2') {
                      event.preventDefault();
                      onCreate('rename', repositoryParentPath(entry.path), entry);
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
                        .then(() =>
                          expanded.has(entry.path) ? state.loadDirectory(entry.path) : onToggle(entry.path),
                        );
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
                    <span className={styles.disclosureSpacer} aria-hidden="true" />
                  )}
                  {entry.kind === 'directory' ? (
                    expanded.has(entry.path) ? (
                      <FolderOpen size={15} />
                    ) : (
                      <Folder size={15} />
                    )
                  ) : (
                    <RepositoryFileIcon path={entry.path} />
                  )}
                  <span>{repositoryBasename(entry.path)}</span>
                </button>
                <div className={styles.actions}>{renderEntryMenu(entry)}</div>
              </div>
            );
          }}
        />
      ) : null}
    </div>
  );
});
