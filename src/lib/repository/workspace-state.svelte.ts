import { RequestError } from '$lib/client/request';
import { RepositoryClient } from './client';
import type { RepositoryDirectoryListing, RepositorySelection, RepositorySnapshot, WorkspaceFile } from './types';

export type RepositoryDeleteTarget = {
	path: string;
	kind: 'file' | 'directory';
};

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
	deleteTarget = $state<RepositoryDeleteTarget>();
	discardChangesPrompt = $state(false);
	changeCount = $state(0);
	worktreeCount = $state(0);

	readonly #api: RepositoryClient;
	readonly #options: RepositoryWorkspaceStateOptions;
	#loadedDirectories: string[] = [];
	#operation: Promise<void> = Promise.resolve();
	#refreshPromise: Promise<void> | undefined;
	#refreshQueued = false;
	#discardChangesResolver: ((discard: boolean) => void) | undefined;

	constructor(sessionId: string, options: RepositoryWorkspaceStateOptions) {
		this.#api = new RepositoryClient(sessionId);
		this.#options = options;
	}

	#enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const next = this.#operation.then(() => operation(), () => operation());
		this.#operation = next.then(() => undefined, () => undefined);
		return next;
	}

	#mergeDirectoryListing(current: RepositorySnapshot, path: string, listing: RepositoryDirectoryListing): RepositorySnapshot {
		const prefix = path ? `${path}/` : '';
		return {
			...current,
			files: [...current.files.filter((entry) => !entry.startsWith(prefix)), ...listing.files],
			directories: [...current.directories.filter((entry) => !entry.startsWith(prefix)), ...listing.directories],
			truncated: path ? current.truncated || listing.truncated : listing.truncated
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
				let nextSnapshot = await this.#api.readSnapshot();
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
		if (!await this.confirmDiscardChanges()) return false;
		this.openedFile = undefined;
		this.selection = nextSelection;
		return true;
	}

	async editFile(path: string): Promise<boolean> {
		return this.selectItem({ kind: 'file', path });
	}

	async createFile(directory: string, name: string) {
		if (!await this.confirmDiscardChanges()) throw new Error('Finish editing the current file first.');
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

	#repositoryPath(directory: string, name: string): string {
		return directory ? `${directory}/${name}` : name;
	}

	requestDelete(path: string, kind: 'file' | 'directory') {
		this.deleteTarget = { path, kind };
	}

	deleteDescription(target: RepositoryDeleteTarget): string {
		const selectedPath = this.selection?.path;
		const discardsChanges = Boolean(this.fileDirty && selectedPath && this.#pathContainsEntry(selectedPath, target.path, target.kind));
		const targetDescription = target.kind === 'directory'
			? `“${target.path}” and everything inside it will be permanently deleted.`
			: `“${target.path}” will be permanently deleted.`;
		return discardsChanges ? `${targetDescription} The open file has unsaved changes that will be discarded.` : targetDescription;
	}

	#pathContainsEntry(path: string, entryPath: string, kind: 'file' | 'directory'): boolean {
		return kind === 'directory' ? path === entryPath || path.startsWith(`${entryPath}/`) : path === entryPath;
	}

	async confirmDelete() {
		if (!this.deleteTarget) return;
		const target = this.deleteTarget;
		const selectedPath = this.selection?.path;
		const deletingSelected = Boolean(selectedPath && this.#pathContainsEntry(selectedPath, target.path, target.kind));

		await this.#enqueue(async () => {
			await this.#api.deleteEntry(target.path, target.kind);
			if (target.kind === 'directory') {
				this.#loadedDirectories = this.#loadedDirectories.filter((directory) => directory !== target.path && !directory.startsWith(`${target.path}/`));
			}
			if (deletingSelected) this.clearSelection();
		});
		await this.refresh();
		this.deleteTarget = undefined;
	}

	handleFileSaved(saved: WorkspaceFile) {
		this.openedFile = saved;
		this.fileDirty = false;
		void this.refresh();
	}

	async closeViewer(): Promise<boolean> {
		if (!await this.confirmDiscardChanges()) return false;
		this.clearSelection();
		return true;
	}

	handleStatus(changeCount: number, worktreeCount: number) {
		this.changeCount = changeCount;
		this.worktreeCount = worktreeCount;
		if (this.#options.isOpen()) void this.refresh();
	}
}
