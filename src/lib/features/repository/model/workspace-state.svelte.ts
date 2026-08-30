import { RequestError } from '~/lib/shared/api/request.ts';
import type { WorkspaceEntryDragData } from '~/lib/shared/lib/workspace-entry-drag.ts';
import { RepositoryClient } from '../api/client.ts';
import type {
  RepositoryBranch,
  RepositoryChange,
  RepositoryDirectoryListing,
  RepositorySelection,
  RepositorySnapshot,
  WorkspaceEntryKind,
  WorkspaceFile,
  WorkspaceMoveResult,
  WorkspaceUploadConflict,
} from '~/lib/shared/contracts/repository.ts';
import type { WorkspaceUploadCandidate, WorkspaceUploadSelection } from '../api/upload.ts';
import { workspaceUploadPath } from '../api/upload.ts';

export type RepositoryDeleteTarget = {
  path: string;
  kind: 'file' | 'directory';
};

export type RepositoryUploadConflict = {
  candidate: WorkspaceUploadCandidate;
  path: string;
};

export type RepositoryMoveConflict = {
  path: string;
  kind: WorkspaceEntryKind;
  targetDirectory: string;
};

export type RepositoryClipboard = {
  operation: 'copy' | 'cut';
  entries: WorkspaceEntryDragData[];
};

export type RepositoryUploadNoticeKind = '' | 'error';

type RepositoryWorkspaceStateOptions = {
  isOpen: () => boolean;
};

export class RepositoryWorkspaceState {
  snapshot = $state<RepositorySnapshot>();
  loading = $state(true);
  errorMessage = $state('');
  refreshToken = $state(0);
  selection = $state<RepositorySelection>();
  openedFile = $state<WorkspaceFile>();
  fileDirty = $state(false);
  deleteTargets = $state<RepositoryDeleteTarget[]>([]);
  discardChangesPrompt = $state(false);
  uploading = $state(false);
  uploadNoticeKind = $state<RepositoryUploadNoticeKind>('');
  uploadNotice = $state('');
  uploadRevealRequest = $state<{ path: string; token: number }>();
  uploadConflicts = $state<RepositoryUploadConflict[]>([]);
  moving = $state(false);
  moveConflict = $state<RepositoryMoveConflict>();
  clipboard = $state<RepositoryClipboard>();
  discardTarget = $state<RepositoryChange>();
  discarding = $state(false);
  branchDeleteTarget = $state<RepositoryBranch>();
  deletingBranch = $state(false);
  loadingMoreCommits = $state(false);
  changeCount = $state(0);
  worktreeCount = $state(0);
  branch = $state<string>();

  readonly #api: RepositoryClient;
  readonly #options: RepositoryWorkspaceStateOptions;
  #loadedDirectories: string[] = [];
  #operation: Promise<void> = Promise.resolve();
  #refreshPromise: Promise<void> | undefined;
  #refreshQueued = false;
  #discardChangesResolver: ((discard: boolean) => void) | undefined;
  #uploadedFileCount = 0;
  #skippedGitFileCount = 0;
  #uploadFailures: string[] = [];
  #uploadRevealToken = 0;
  #commitLimit = 20;

  constructor(workspaceId: string, options: RepositoryWorkspaceStateOptions) {
    this.#api = new RepositoryClient(workspaceId);
    this.#options = options;
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#operation.then(
      () => operation(),
      () => operation()
    );
    this.#operation = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  #mergeDirectoryListing(
    current: RepositorySnapshot,
    path: string,
    listing: RepositoryDirectoryListing
  ): RepositorySnapshot {
    const prefix = path ? `${path}/` : '';
    return {
      ...current,
      files: [...current.files.filter((entry) => !entry.startsWith(prefix)), ...listing.files],
      directories: [...current.directories.filter((entry) => !entry.startsWith(prefix)), ...listing.directories],
      ignored: [...current.ignored.filter((entry) => !entry.startsWith(prefix)), ...listing.ignored],
      truncated: path ? current.truncated || listing.truncated : listing.truncated,
    };
  }

  async loadDirectory(path: string) {
    return this.#enqueue(async () => {
      if (this.#loadedDirectories.includes(path)) return;
      try {
        const listing = await this.#api.readDirectory(path);
        if (!this.snapshot) throw new Error('Repository information is unavailable.');
        this.snapshot = this.#mergeDirectoryListing(this.snapshot, path, listing);
        this.#loadedDirectories = [...this.#loadedDirectories, path];
      } catch (error) {
        this.errorMessage = error instanceof Error ? error.message : 'Unable to read this folder.';
        throw error;
      }
    });
  }

  async refresh(showLoading = false) {
    if (this.#refreshPromise) {
      this.#refreshQueued = true;
      return;
    }
    if (document.hidden) return;
    const run = this.#enqueue(async () => {
      const shouldShowLoading = showLoading || !this.snapshot;
      if (shouldShowLoading) this.loading = true;
      try {
        let nextSnapshot = await this.#api.readSnapshot(this.#commitLimit);
        const activeDirectories: string[] = [];
        for (const path of this.#loadedDirectories) {
          try {
            nextSnapshot = this.#mergeDirectoryListing(nextSnapshot, path, await this.#api.readDirectory(path));
            activeDirectories.push(path);
          } catch (error) {
            if (error instanceof RequestError && error.status === 404) continue;
            throw error;
          }
        }
        this.#loadedDirectories = activeDirectories;
        this.snapshot = nextSnapshot;
        this.changeCount = nextSnapshot.changes.length;
        this.branch = nextSnapshot.git?.branch;
        this.errorMessage = '';
        this.refreshToken += 1;
      } catch (error) {
        this.errorMessage = error instanceof Error ? error.message : 'Unable to refresh this repository.';
      } finally {
        if (shouldShowLoading) this.loading = false;
      }
    });
    this.#refreshPromise = run;
    try {
      await run;
    } finally {
      if (this.#refreshPromise === run) this.#refreshPromise = undefined;
      if (this.#refreshQueued) {
        this.#refreshQueued = false;
        if (this.#options.isOpen() && !document.hidden) void this.refresh();
      }
    }
  }

  confirmDiscardChanges(): Promise<boolean> {
    if (!this.fileDirty) return Promise.resolve(true);
    if (this.#discardChangesResolver) return Promise.resolve(false);
    this.discardChangesPrompt = true;
    return new Promise((resolve) => {
      this.#discardChangesResolver = resolve;
    });
  }

  resolveDiscardChanges(discard: boolean) {
    const resolve = this.#discardChangesResolver;
    this.#discardChangesResolver = undefined;
    this.discardChangesPrompt = false;
    if (discard) this.fileDirty = false;
    resolve?.(discard);
  }

  clearSelection() {
    this.selection = undefined;
    this.openedFile = undefined;
    this.fileDirty = false;
  }

  async selectItem(nextSelection: RepositorySelection): Promise<boolean> {
    if (!(await this.confirmDiscardChanges())) return false;
    this.openedFile = undefined;
    this.selection = nextSelection;
    return true;
  }

  async editFile(path: string): Promise<boolean> {
    return this.selectItem({ kind: 'file', path });
  }

  async createFile(directory: string, name: string) {
    if (!(await this.confirmDiscardChanges())) throw new Error('Finish editing the current file first.');
    const path = this.#repositoryPath(directory, name);
    await this.#enqueue(async () => {
      const created = await this.#api.createFile(path);
      this.openedFile = created;
      this.fileDirty = false;
      this.selection = { kind: 'file', path: created.path };
    });
    await this.refresh();
  }

  async createDirectory(directory: string, name: string) {
    const path = this.#repositoryPath(directory, name);
    await this.#enqueue(() => this.#api.createDirectory(path));
    await this.refresh();
  }

  #setUploadError(message: string) {
    this.uploadNoticeKind = 'error';
    this.uploadNotice = message;
  }

  #clearUploadNotice() {
    this.uploadNoticeKind = '';
    this.uploadNotice = '';
  }

  #revealUploadedPath(path: string | undefined) {
    if (!path) return;
    this.uploadRevealRequest = { path, token: ++this.#uploadRevealToken };
  }

  #uploadTouchesDirtyFile(paths: string[]): boolean {
    return Boolean(this.fileDirty && this.selection?.kind === 'file' && paths.includes(this.selection.path));
  }

  #uploadSummary(skippedExisting = 0): string {
    const parts = [`Added ${this.#uploadedFileCount} ${this.#uploadedFileCount === 1 ? 'file' : 'files'}.`];
    if (skippedExisting > 0)
      parts.push(`Skipped ${skippedExisting} existing ${skippedExisting === 1 ? 'file' : 'files'}.`);
    if (this.#skippedGitFileCount > 0) parts.push('Git metadata was skipped.');
    if (this.#uploadFailures.length > 0) {
      parts.push(
        `${this.#uploadFailures.length} ${this.#uploadFailures.length === 1 ? 'file failed' : 'files failed'}: ${this.#uploadFailures[0]}`
      );
    }
    return parts.join(' ');
  }

  async uploadFiles(selection: WorkspaceUploadSelection, directory = '') {
    if (this.uploading) return;
    const uploads = selection.candidates.map((candidate) => ({
      candidate,
      path: workspaceUploadPath(directory, candidate.relativePath),
    }));
    if (this.#uploadTouchesDirtyFile(uploads.map(({ path }) => path)) && !(await this.confirmDiscardChanges())) return;

    this.uploading = true;
    this.#clearUploadNotice();
    this.uploadConflicts = [];
    this.#uploadedFileCount = 0;
    this.#skippedGitFileCount = selection.skippedGitFiles;
    this.#uploadFailures = [];
    const conflicts: RepositoryUploadConflict[] = [];
    const uploadedPaths: string[] = [];
    try {
      for (const upload of uploads) {
        try {
          const result = await this.#api.uploadFile(upload.path, upload.candidate.file);
          this.#uploadedFileCount += 1;
          uploadedPaths.push(result.path);
        } catch (error) {
          if (error instanceof RequestError && error.status === 409) {
            conflicts.push(upload);
          } else {
            this.#uploadFailures.push(error instanceof Error ? error.message : `“${upload.path}” could not be added.`);
          }
        }
      }
    } finally {
      this.uploading = false;
    }

    await this.refresh();
    this.#revealUploadedPath(uploadedPaths.at(-1));
    this.uploadConflicts = conflicts;
    if (this.#uploadFailures.length > 0) {
      this.#setUploadError(this.#uploadSummary());
    }
  }

  reportUploadError(message: string) {
    this.#setUploadError(message);
  }

  async resolveUploadConflicts(conflict: WorkspaceUploadConflict | 'skip') {
    if (this.uploading || this.uploadConflicts.length === 0) return;
    const uploads = this.uploadConflicts;
    if (conflict === 'skip') {
      this.uploadConflicts = [];
      if (this.#uploadFailures.length > 0) this.#setUploadError(this.#uploadSummary(uploads.length));
      return;
    }

    if (conflict === 'overwrite' && this.#uploadTouchesDirtyFile(uploads.map(({ path }) => path))) {
      this.uploadConflicts = [];
      if (!(await this.confirmDiscardChanges())) {
        this.uploadConflicts = uploads;
        return;
      }
    }

    this.uploading = true;
    this.uploadConflicts = [];
    const uploadedPaths: string[] = [];
    try {
      for (const upload of uploads) {
        try {
          const result = await this.#api.uploadFile(upload.path, upload.candidate.file, conflict);
          this.#uploadedFileCount += 1;
          uploadedPaths.push(result.path);
        } catch (error) {
          this.#uploadFailures.push(error instanceof Error ? error.message : `“${upload.path}” could not be added.`);
        }
      }
    } finally {
      this.uploading = false;
    }

    await this.refresh();
    this.#revealUploadedPath(uploadedPaths.at(-1));
    if (this.#uploadFailures.length > 0) {
      this.#setUploadError(this.#uploadSummary());
    }
  }

  async addFilesForTerminal(selection: WorkspaceUploadSelection): Promise<WorkspaceEntryDragData[]> {
    if (this.uploading) throw new Error('Wait for the current file operation to finish.');
    this.uploading = true;
    this.#clearUploadNotice();
    this.uploadConflicts = [];
    this.#uploadedFileCount = 0;
    this.#skippedGitFileCount = selection.skippedGitFiles;
    this.#uploadFailures = [];
    const added: Array<{ candidate: WorkspaceUploadCandidate; path: string }> = [];
    try {
      for (const candidate of selection.candidates) {
        try {
          const result = await this.#api.uploadFile(candidate.relativePath, candidate.file, 'rename');
          added.push({ candidate, path: result.path });
          this.#uploadedFileCount += 1;
        } catch (error) {
          this.#uploadFailures.push(
            error instanceof Error ? error.message : `“${candidate.relativePath}” could not be added.`
          );
        }
      }
    } finally {
      this.uploading = false;
    }

    await this.refresh();
    if (this.#uploadFailures.length > 0) this.#setUploadError(this.#uploadSummary());
    if (added.length === 0) {
      throw new Error(this.#uploadFailures[0] || 'The dropped files could not be added.');
    }

    const entries = new Map<string, WorkspaceEntryDragData>();
    for (const item of added) {
      const separator = item.candidate.relativePath.indexOf('/');
      const entry: WorkspaceEntryDragData =
        separator >= 0
          ? { path: item.candidate.relativePath.slice(0, separator), kind: 'directory' }
          : { path: item.path, kind: 'file' };
      entries.set(`${entry.kind}:${entry.path}`, entry);
    }
    return [...entries.values()];
  }

  #repositoryPath(directory: string, name: string): string {
    return directory ? `${directory}/${name}` : name;
  }

  #rebaseMovedPath(path: string, result: WorkspaceMoveResult): string {
    if (path === result.fromPath) return result.path;
    if (result.kind === 'directory' && path.startsWith(`${result.fromPath}/`)) {
      return `${result.path}${path.slice(result.fromPath.length)}`;
    }
    return path;
  }

  async #performMove(
    path: string,
    kind: WorkspaceEntryKind,
    targetDirectory: string,
    conflict: 'reject' | 'rename'
  ): Promise<WorkspaceMoveResult> {
    const result = await this.#enqueue(() => this.#api.moveEntry(path, kind, targetDirectory, conflict));
    this.#loadedDirectories = [
      ...new Set(this.#loadedDirectories.map((directory) => this.#rebaseMovedPath(directory, result))),
    ];
    if (this.selection) {
      const nextPath = this.#rebaseMovedPath(this.selection.path, result);
      if (nextPath !== this.selection.path) {
        this.selection = { ...this.selection, path: nextPath };
        this.openedFile = undefined;
        this.fileDirty = false;
      }
    }
    await this.refresh();
    return result;
  }

  async moveEntry(
    path: string,
    kind: WorkspaceEntryKind,
    targetDirectory: string
  ): Promise<WorkspaceMoveResult | undefined> {
    if (this.moving) return;
    const selectedPath = this.selection?.path;
    if (
      this.fileDirty &&
      selectedPath &&
      this.#pathContainsEntry(selectedPath, path, kind) &&
      !(await this.confirmDiscardChanges())
    )
      return;

    this.moving = true;
    this.moveConflict = undefined;
    try {
      const result = await this.#performMove(path, kind, targetDirectory, 'reject');
      this.errorMessage = '';
      return result;
    } catch (error) {
      if (error instanceof RequestError && error.status === 409) {
        this.moveConflict = { path, kind, targetDirectory };
        return;
      }
      this.errorMessage = error instanceof Error ? error.message : 'The entry could not be moved.';
      return;
    } finally {
      this.moving = false;
    }
  }

  async resolveMoveConflict(resolution: 'cancel' | 'rename'): Promise<WorkspaceMoveResult | undefined> {
    const pending = this.moveConflict;
    if (!pending || this.moving) return;
    if (resolution === 'cancel') {
      this.moveConflict = undefined;
      return;
    }

    this.moving = true;
    this.moveConflict = undefined;
    try {
      const result = await this.#performMove(pending.path, pending.kind, pending.targetDirectory, 'rename');
      this.errorMessage = '';
      return result;
    } catch (error) {
      this.moveConflict = pending;
      this.errorMessage = error instanceof Error ? error.message : 'The entry could not be moved.';
      throw error;
    } finally {
      this.moving = false;
    }
  }

  #minimalEntries(entries: WorkspaceEntryDragData[]): WorkspaceEntryDragData[] {
    const unique = new Map(entries.map((entry) => [`${entry.kind}:${entry.path}`, entry]));
    return [...unique.values()].filter(
      (entry) =>
        ![...unique.values()].some(
          (candidate) =>
            candidate.kind === 'directory' &&
            candidate.path !== entry.path &&
            entry.path.startsWith(`${candidate.path}/`)
        )
    );
  }

  setClipboard(operation: 'copy' | 'cut', entries: WorkspaceEntryDragData[]) {
    const selected = this.#minimalEntries(entries);
    this.clipboard = selected.length > 0 ? { operation, entries: selected } : undefined;
  }

  async pasteEntries(targetDirectory: string): Promise<WorkspaceMoveResult[]> {
    const clipboard = this.clipboard;
    if (!clipboard || clipboard.entries.length === 0 || this.moving) return [];
    this.moving = true;
    const results: WorkspaceMoveResult[] = [];
    try {
      for (const entry of clipboard.entries) {
        if (clipboard.operation === 'copy') {
          results.push(
            await this.#enqueue(() => this.#api.copyEntry(entry.path, entry.kind, targetDirectory, 'rename'))
          );
        } else {
          results.push(await this.#performMove(entry.path, entry.kind, targetDirectory, 'rename'));
        }
      }
      if (clipboard.operation === 'copy') await this.refresh();
      else this.clipboard = undefined;
      this.errorMessage = '';
      return results;
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : 'The selected entries could not be pasted.';
      throw error;
    } finally {
      this.moving = false;
    }
  }

  async renameEntry(path: string, kind: WorkspaceEntryKind, targetName: string): Promise<WorkspaceMoveResult> {
    const selectedPath = this.selection?.path;
    if (
      this.fileDirty &&
      selectedPath &&
      this.#pathContainsEntry(selectedPath, path, kind) &&
      !(await this.confirmDiscardChanges())
    ) {
      throw new Error('Finish editing the current file first.');
    }
    const result = await this.#enqueue(() => this.#api.renameEntry(path, kind, targetName));
    this.#loadedDirectories = [
      ...new Set(this.#loadedDirectories.map((directory) => this.#rebaseMovedPath(directory, result))),
    ];
    if (this.selection) {
      const nextPath = this.#rebaseMovedPath(this.selection.path, result);
      if (nextPath !== this.selection.path) {
        this.selection = { ...this.selection, path: nextPath };
        this.openedFile = undefined;
        this.fileDirty = false;
      }
    }
    await this.refresh();
    return result;
  }

  requestDiscardChange(change: RepositoryChange | string) {
    const target =
      typeof change === 'string' ? this.snapshot?.changes.find((candidate) => candidate.path === change) : change;
    if (!target) {
      this.errorMessage = 'This path no longer has changes to discard.';
      return;
    }
    this.discardTarget = target;
  }

  discardChangeTitle(change: RepositoryChange): string {
    return change.status === '??' ? 'Delete untracked file?' : 'Discard Git changes?';
  }

  discardChangeDescription(change: RepositoryChange): string {
    const quotedPath = `“${change.path}”`;
    let description: string;
    if (change.status === '??') {
      description = `${quotedPath} is not tracked by Git. Discarding it permanently deletes the file.`;
    } else if (change.status[0] === 'A') {
      description = `${quotedPath} was newly added to Git. Discarding removes it from both Git and the workspace.`;
    } else if (change.status.includes('R') && change.previousPath) {
      description = `${quotedPath} will be removed and “${change.previousPath}” will be restored. Staged and working tree changes will be lost.`;
    } else {
      description = `${quotedPath} will be restored to its HEAD version. Staged and working tree changes will be lost.`;
    }
    if (
      this.fileDirty &&
      this.selection?.kind === 'file' &&
      [change.path, change.previousPath].includes(this.selection.path)
    ) {
      description += ' Unsaved editor changes will also be discarded.';
    }
    return description;
  }

  async confirmDiscardChange() {
    const target = this.discardTarget;
    if (!target || this.discarding) return;
    this.discarding = true;
    try {
      await this.#enqueue(() => this.#api.discardChange(target));
      if (this.selection && [target.path, target.previousPath].includes(this.selection.path)) {
        this.clearSelection();
      }
      this.discardTarget = undefined;
      await this.refresh();
    } finally {
      this.discarding = false;
    }
  }

  requestDeleteBranch(branch: RepositoryBranch) {
    if (branch.worktreePath) {
      this.errorMessage = 'A branch checked out in a worktree cannot be deleted.';
      return;
    }
    this.branchDeleteTarget = branch;
  }

  async confirmDeleteBranch() {
    const target = this.branchDeleteTarget;
    if (!target || this.deletingBranch) return;
    this.deletingBranch = true;
    try {
      await this.#enqueue(() => this.#api.deleteBranch(target.name));
      this.branchDeleteTarget = undefined;
      await this.refresh();
    } finally {
      this.deletingBranch = false;
    }
  }

  async loadMoreCommits() {
    const git = this.snapshot?.git;
    if (!git?.hasMoreCommits || this.loadingMoreCommits) return;
    this.loadingMoreCommits = true;
    try {
      await this.#enqueue(async () => {
        const current = this.snapshot;
        if (!current?.git?.hasMoreCommits) return;
        const page = await this.#api.readCommits(current.git.commits.length);
        const knownHashes = new Set(current.git.commits.map((commit) => commit.hash));
        const commits = [
          ...current.git.commits,
          ...page.commits.filter((commit) => !knownHashes.has(commit.hash)),
        ];
        this.#commitLimit = commits.length;
        this.snapshot = {
          ...current,
          git: { ...current.git, commits, hasMoreCommits: page.hasMore },
        };
        this.errorMessage = '';
      });
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : 'Unable to load more commits.';
    } finally {
      this.loadingMoreCommits = false;
    }
  }

  requestDelete(path: string, kind: 'file' | 'directory') {
    this.requestDeleteEntries([{ path, kind }]);
  }

  requestDeleteEntries(entries: RepositoryDeleteTarget[]) {
    this.deleteTargets = this.#minimalEntries(entries);
  }

  deleteDescription(targets: RepositoryDeleteTarget[]): string {
    if (targets.length > 1) {
      const selectedPath = this.selection?.path;
      const discardsChanges = Boolean(
        this.fileDirty &&
          selectedPath &&
          targets.some((target) => this.#pathContainsEntry(selectedPath, target.path, target.kind))
      );
      const description = `${targets.length} selected items will be permanently deleted.`;
      return discardsChanges ? `${description} The open file has unsaved changes that will be discarded.` : description;
    }
    const target = targets[0];
    if (!target) return 'The selected item will be permanently deleted.';
    const selectedPath = this.selection?.path;
    const discardsChanges = Boolean(
      this.fileDirty && selectedPath && this.#pathContainsEntry(selectedPath, target.path, target.kind)
    );
    const targetDescription =
      target.kind === 'directory'
        ? `“${target.path}” and everything inside it will be permanently deleted.`
        : `“${target.path}” will be permanently deleted.`;
    return discardsChanges
      ? `${targetDescription} The open file has unsaved changes that will be discarded.`
      : targetDescription;
  }

  #pathContainsEntry(path: string, entryPath: string, kind: 'file' | 'directory'): boolean {
    return kind === 'directory' ? path === entryPath || path.startsWith(`${entryPath}/`) : path === entryPath;
  }

  async confirmDelete() {
    if (this.deleteTargets.length === 0) return;
    const targets = this.deleteTargets;
    for (const target of targets) {
      const selectedPath = this.selection?.path;
      const deletingSelected = Boolean(selectedPath && this.#pathContainsEntry(selectedPath, target.path, target.kind));
      await this.#enqueue(() => this.#api.deleteEntry(target.path, target.kind));
      if (target.kind === 'directory') {
        this.#loadedDirectories = this.#loadedDirectories.filter(
          (directory) => directory !== target.path && !directory.startsWith(`${target.path}/`)
        );
      }
      if (deletingSelected) this.clearSelection();
      this.deleteTargets = this.deleteTargets.filter(
        (candidate) => candidate.path !== target.path || candidate.kind !== target.kind
      );
    }
    await this.refresh();
  }

  dispose() {
    this.resolveDiscardChanges(false);
  }

  handleFileSaved(saved: WorkspaceFile, dirty = false) {
    this.openedFile = saved;
    this.fileDirty = dirty;
    void this.refresh();
  }

  async closeViewer(): Promise<boolean> {
    if (!(await this.confirmDiscardChanges())) return false;
    this.clearSelection();
    return true;
  }

  handleStatus(changeCount: number, worktreeCount: number, branch?: string) {
    this.changeCount = changeCount;
    this.worktreeCount = worktreeCount;
    this.branch = branch;
    if (this.#options.isOpen()) void this.refresh();
  }
}
