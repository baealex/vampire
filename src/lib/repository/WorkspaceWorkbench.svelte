<script lang="ts">
	import { onMount } from 'svelte';
	import Terminal from '$lib/Terminal.svelte';
	import type { ManagedSession, MobilePanel } from '$lib/session/types';
	import { projectName as getProjectName } from '$lib/session/view';
	import type { SystemMetrics } from '$lib/system-metrics';
	import ConfirmDialog from '$lib/ConfirmDialog.svelte';
	import RepositoryPanel from './RepositoryPanel.svelte';
	import RepositoryViewer from './RepositoryViewer.svelte';
	import type { RepositoryDirectoryListing, RepositorySelection, RepositorySnapshot, WorkspaceFile } from './types';

	let {
		session,
		close,
		onUpdateNote,
		onLoadNote,
		onInputActivity,
		onOutputActivity,
		systemMetrics,
		mobilePanel,
		onMobilePanelChange = () => undefined
	}: {
		session: ManagedSession;
		close: () => void;
		onUpdateNote: (sessionId: string, note: string) => Promise<void>;
		onLoadNote: (sessionId: string) => Promise<string>;
		onInputActivity: (sessionId: string, timestamp: number) => void;
		onOutputActivity: (sessionId: string, active: boolean, timestamp?: number) => void;
		systemMetrics?: SystemMetrics;
		mobilePanel?: MobilePanel;
		onMobilePanelChange?: (panel: MobilePanel | undefined) => void;
	} = $props();

	let snapshot = $state<RepositorySnapshot>();
	let repositoryLoading = $state(true);
	let repositoryError = $state('');
	let repositoryRefreshToken = $state(0);
	let selection = $state<RepositorySelection>();
	let openedFile = $state<WorkspaceFile>();
	let fileDirty = $state(false);
	let deleteTarget = $state<{ path: string; kind: 'file' | 'directory' }>();
	let loadedDirectories = $state<string[]>([]);
	let desktopRepositoryOpen = $state(false);
	let desktop = $state(false);
	let refreshInFlight = false;
	let refreshQueued = false;
	const name = $derived(getProjectName(session.cwd));
	let changeCount = $state(0);
	const repositoryOpen = $derived(desktop ? desktopRepositoryOpen : mobilePanel === 'repository');

	class RepositoryRequestError extends Error {
		status: number;

		constructor(status: number, message: string) {
			super(message);
			this.status = status;
		}
	}

	function mergeDirectoryListing(current: RepositorySnapshot, path: string, listing: RepositoryDirectoryListing): RepositorySnapshot {
		const prefix = path ? `${path}/` : '';
		return {
			...current,
			files: [...current.files.filter((entry) => !entry.startsWith(prefix)), ...listing.files],
			directories: [...current.directories.filter((entry) => !entry.startsWith(prefix)), ...listing.directories],
			truncated: path ? current.truncated || listing.truncated : listing.truncated
		};
	}

	async function fetchRepositoryDirectory(path: string): Promise<RepositoryDirectoryListing> {
		const query = path ? `?${new URLSearchParams({ path }).toString()}` : '';
		const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/repository/directory${query}`);
		if (!response.ok) throw new RepositoryRequestError(response.status, await readRepositoryError(response, 'Unable to read this folder.'));
		return await response.json() as RepositoryDirectoryListing;
	}

	async function loadRepositoryDirectory(path: string) {
		if (loadedDirectories.includes(path)) return;
		try {
			const listing = await fetchRepositoryDirectory(path);
			if (!snapshot) throw new Error('Repository information is unavailable.');
			snapshot = mergeDirectoryListing(snapshot, path, listing);
			loadedDirectories = [...loadedDirectories, path];
		} catch (error) {
			repositoryError = error instanceof Error ? error.message : 'Unable to read this folder.';
			throw error;
		}
	}

	async function refreshRepository(showLoading = false) {
		if (refreshInFlight) {
			refreshQueued = true;
			return;
		}
		if (document.hidden) return;
		refreshInFlight = true;
		const shouldShowLoading = showLoading || !snapshot;
		if (shouldShowLoading) repositoryLoading = true;
		try {
			const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/repository`);
			if (!response.ok) {
				const body: unknown = await response.json().catch(() => undefined);
				const message = body && typeof body === 'object' && 'message' in body && typeof body.message === 'string'
					? body.message
					: 'Unable to refresh this repository.';
				throw new Error(message);
			}
			let nextSnapshot = await response.json() as RepositorySnapshot;
			const activeDirectories: string[] = [];
			for (const path of loadedDirectories) {
				try {
					nextSnapshot = mergeDirectoryListing(nextSnapshot, path, await fetchRepositoryDirectory(path));
					activeDirectories.push(path);
				} catch (error) {
					if (error instanceof RepositoryRequestError && error.status === 404) continue;
					throw error;
				}
			}
			loadedDirectories = activeDirectories;
			snapshot = nextSnapshot;
			changeCount = snapshot.changes.length;
			repositoryError = '';
			repositoryRefreshToken += 1;
		} catch (error) {
			repositoryError = error instanceof Error ? error.message : 'Unable to refresh this repository.';
		} finally {
			if (shouldShowLoading) repositoryLoading = false;
			refreshInFlight = false;
			if (refreshQueued) {
				refreshQueued = false;
				if (repositoryOpen && !document.hidden) void refreshRepository();
			}
		}
	}

	function toggleRepository() {
		if (repositoryOpen) {
			closeRepository();
			return;
		}
		if (desktop) desktopRepositoryOpen = true;
		else onMobilePanelChange('repository');
	}

	function closeRepository() {
		if (!confirmDiscardChanges()) return false;
		if (desktop) desktopRepositoryOpen = false;
		else onMobilePanelChange(undefined);
		selection = undefined;
		openedFile = undefined;
		fileDirty = false;
		return true;
	}

	function confirmDiscardChanges(): boolean {
		if (!fileDirty) return true;
		const discard = window.confirm('Discard unsaved file changes?');
		if (discard) fileDirty = false;
		return discard;
	}

	function openSessionNavigator() {
		if (repositoryOpen) {
			if (!closeRepository()) return;
		} else if (!confirmDiscardChanges()) {
			return;
		}
		close();
	}

	function selectRepositoryItem(nextSelection: RepositorySelection) {
		if (!confirmDiscardChanges()) return;
		openedFile = undefined;
		selection = nextSelection;
		if (!desktop) onMobilePanelChange(undefined);
	}

	function editRepositoryFile(path: string) {
		if (!confirmDiscardChanges()) return;
		openedFile = undefined;
		selection = { kind: 'file', path };
		if (!desktop) onMobilePanelChange(undefined);
	}

	function repositoryPath(directory: string, name: string): string {
		return directory ? `${directory}/${name}` : name;
	}

	async function readRepositoryError(response: Response, fallback: string): Promise<string> {
		const body: unknown = await response.json().catch(() => undefined);
		return body && typeof body === 'object' && 'message' in body && typeof body.message === 'string'
			? body.message
			: fallback;
	}

	async function createFile(directory: string, name: string) {
		if (!confirmDiscardChanges()) throw new Error('Finish editing the current file first.');
		const path = repositoryPath(directory, name);
		const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/repository/file`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ path, content: '' })
		});
		if (!response.ok) throw new Error(await readRepositoryError(response, 'The file could not be created.'));
		const created = await response.json() as WorkspaceFile;
		openedFile = created;
		fileDirty = false;
		selection = { kind: 'file', path: created.path };
		await refreshRepository();
		if (!desktop) onMobilePanelChange(undefined);
	}

	async function createDirectory(directory: string, name: string) {
		const path = repositoryPath(directory, name);
		const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/repository/directory`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ path })
		});
		if (!response.ok) throw new Error(await readRepositoryError(response, 'The folder could not be created.'));
		await refreshRepository();
	}

	function requestDelete(path: string, kind: 'file' | 'directory') {
		deleteTarget = { path, kind };
	}

	function pathContainsEntry(path: string, entryPath: string, kind: 'file' | 'directory'): boolean {
		return kind === 'directory' ? path === entryPath || path.startsWith(`${entryPath}/`) : path === entryPath;
	}

	function deleteDescription(target: { path: string; kind: 'file' | 'directory' }): string {
		const selectedPath = selection?.path;
		const discardsChanges = Boolean(fileDirty && selectedPath && pathContainsEntry(selectedPath, target.path, target.kind));
		const targetDescription = target.kind === 'directory'
			? `“${target.path}” and everything inside it will be permanently deleted.`
			: `“${target.path}” will be permanently deleted.`;
		return discardsChanges ? `${targetDescription} The open file has unsaved changes that will be discarded.` : targetDescription;
	}

	async function confirmDelete() {
		if (!deleteTarget) return;
		const target = deleteTarget;
		const selectedPath = selection?.path;
		const deletingSelected = Boolean(selectedPath && pathContainsEntry(selectedPath, target.path, target.kind));

		const endpoint = target.kind === 'directory' ? 'directory' : 'file';
		const query = new URLSearchParams({ path: target.path });
		const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/repository/${endpoint}?${query}`, {
			method: 'DELETE'
		});
		if (!response.ok) throw new Error(await readRepositoryError(response, `The ${target.kind === 'directory' ? 'folder' : 'file'} could not be deleted.`));

		if (target.kind === 'directory') {
			loadedDirectories = loadedDirectories.filter((directory) => directory !== target.path && !directory.startsWith(`${target.path}/`));
		}
		if (deletingSelected) {
			selection = undefined;
			openedFile = undefined;
			fileDirty = false;
		}
		await refreshRepository();
		deleteTarget = undefined;
	}

	function handleFileSaved(saved: WorkspaceFile) {
		openedFile = saved;
		fileDirty = false;
		void refreshRepository();
	}

	function closeViewer() {
		if (!confirmDiscardChanges()) return;
		selection = undefined;
		openedFile = undefined;
		fileDirty = false;
	}

	function handleRepositoryStatus(nextChangeCount: number) {
		changeCount = nextChangeCount;
		if (repositoryOpen) void refreshRepository();
	}

	$effect(() => {
		if (!repositoryOpen) return;
		const refreshWhenVisible = () => {
			if (!document.hidden) void refreshRepository();
		};
		void refreshRepository();
		document.addEventListener('visibilitychange', refreshWhenVisible);

		return () => {
			document.removeEventListener('visibilitychange', refreshWhenVisible);
		};
	});

	onMount(() => {
		const desktopQuery = window.matchMedia('(min-width: 64rem)');
		const syncDesktop = () => desktop = desktopQuery.matches;
		const closeOverlay = (event: KeyboardEvent) => {
			if (event.key !== 'Escape') return;
			if (event.target instanceof HTMLElement && event.target.closest('[data-inline-repository-entry]')) return;
			if (repositoryOpen) {
				event.preventDefault();
				closeRepository();
			} else if (selection) {
				event.preventDefault();
				closeViewer();
			}
		};
		syncDesktop();
		desktopQuery.addEventListener('change', syncDesktop);
		window.addEventListener('keydown', closeOverlay, { capture: true });

		return () => {
			desktopQuery.removeEventListener('change', syncDesktop);
			window.removeEventListener('keydown', closeOverlay, { capture: true });
		};
	});
</script>

<section class="workspace-workbench" class:repository-open={repositoryOpen}>
	<div class="workspace-primary">
		<Terminal
			{session}
			close={openSessionNavigator}
			{onUpdateNote}
			{onLoadNote}
			{onInputActivity}
			{onOutputActivity}
			{systemMetrics}
			{repositoryOpen}
			{changeCount}
			onRepositoryStatus={handleRepositoryStatus}
			onToggleRepository={toggleRepository}
		>
			{#if selection}
					<RepositoryViewer
						sessionId={session.id}
						{selection}
						refreshToken={repositoryRefreshToken}
						initialFile={openedFile}
						onClose={closeViewer}
						onEditFile={editRepositoryFile}
						onFileSaved={handleFileSaved}
					onFileDirtyChange={(dirty) => fileDirty = dirty}
				/>
			{/if}
		</Terminal>
	</div>

	<RepositoryPanel
		projectName={name}
		{snapshot}
		loading={repositoryLoading}
		errorMessage={repositoryError}
		selected={selection}
		open={repositoryOpen}
		onRefresh={() => void refreshRepository(true)}
		onLoadDirectory={loadRepositoryDirectory}
		onCreateFile={createFile}
		onCreateDirectory={createDirectory}
		onRequestDelete={requestDelete}
		onClose={closeRepository}
		onSelect={selectRepositoryItem}
	/>

	{#if deleteTarget}
		<ConfirmDialog
			title={deleteTarget.kind === 'directory' ? 'Delete folder?' : 'Delete file?'}
			description={deleteDescription(deleteTarget)}
			confirmLabel={deleteTarget.kind === 'directory' ? 'Delete folder' : 'Delete file'}
			busyLabel="Deleting…"
			close={() => deleteTarget = undefined}
			onConfirm={confirmDelete}
		/>
	{/if}
</section>

<style>
	.workspace-workbench, .workspace-primary { width: 100%; min-width: 0; min-height: 0; }
	.workspace-workbench { position: relative; height: 100dvh; overflow: hidden; }
	.workspace-primary { position: relative; height: 100%; transition: margin-right 180ms ease; }

	@media (min-width: 80rem) {
		.workspace-workbench.repository-open .workspace-primary { width: auto; margin-right: 22rem; }
	}

	@media (prefers-reduced-motion: reduce) {
		.workspace-primary { transition: none; }
	}
</style>
