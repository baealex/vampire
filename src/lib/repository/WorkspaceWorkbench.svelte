<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import Terminal from '$lib/Terminal.svelte';
	import type { ManagedSession, MobilePanel, SessionTerminal } from '$lib/session/types';
	import { projectName as getProjectName } from '$lib/session/view';
	import type { SystemMetrics } from '$lib/system-metrics';
	import ConfirmDialog from '$lib/ConfirmDialog.svelte';
	import { REPOSITORY_SPLIT_MEDIA_QUERY } from '$lib/ui/layout';
	import { isUiOverlayOpen } from '$lib/ui/overlay';
	import type { TerminalPathInsertionRequest, WorkspaceEntryDragData } from '$lib/workspace-entry-drag.ts';
	import MoveConflictDialog from './MoveConflictDialog.svelte';
	import RepositoryPanel from './RepositoryPanel.svelte';
	import RepositoryViewer from './RepositoryViewer.svelte';
	import UploadConflictDialog from './UploadConflictDialog.svelte';
	import { uploadSelectionFromDataTransfer } from './upload';
	import { RepositoryWorkspaceState } from './workspace-state.svelte';
	import type { RepositorySelection, RepositoryTab } from './types';

	let {
		session,
		onStartBackground,
		onStopBackground,
		onLoadBackgroundOutput,
		onFavoriteBackground,
		onRemoveBackgroundFavorite,
		startingBackground = false,
		stoppingBackgroundProcessId,
		updatingFavoriteCommand,
		backgroundActionError = '',
		close,
		onUpdateNote,
		onLoadNote,
		onInputActivity,
		onOutputActivity,
		onTerminalPresentationChange = () => undefined,
		systemMetrics,
		mobilePanel,
		onMobilePanelChange = () => undefined,
		repositoryPanelOpen = false,
		onRepositoryPanelOpenChange = () => undefined,
		repositoryTab = 'changes',
		onRepositoryTabChange = () => undefined
	}: {
		session: ManagedSession;
		onStartBackground: (command: string) => Promise<SessionTerminal | undefined>;
		onStopBackground: (process: SessionTerminal) => Promise<boolean>;
		onLoadBackgroundOutput: (processId: string) => Promise<string>;
		onFavoriteBackground: (command: string) => Promise<boolean>;
		onRemoveBackgroundFavorite: (command: string) => Promise<boolean>;
		startingBackground?: boolean;
		stoppingBackgroundProcessId?: string;
		updatingFavoriteCommand?: string;
		backgroundActionError?: string;
		close: () => void;
		onUpdateNote: (sessionId: string, note: string) => Promise<void>;
		onLoadNote: (sessionId: string) => Promise<string>;
		onInputActivity: (sessionId: string, timestamp: number) => void;
		onOutputActivity: (sessionId: string, active: boolean, timestamp?: number) => void;
		onTerminalPresentationChange?: (sessionId: string, presented: boolean) => void;
		systemMetrics?: SystemMetrics;
		mobilePanel?: MobilePanel;
		onMobilePanelChange?: (panel: MobilePanel | undefined) => void;
		repositoryPanelOpen?: boolean;
		onRepositoryPanelOpenChange?: (open: boolean) => void;
		repositoryTab?: RepositoryTab;
		onRepositoryTabChange?: (tab: RepositoryTab) => void;
	} = $props();

	let desktop = $state(false);
	let pathInsertionRequest = $state<TerminalPathInsertionRequest>();
	let pathInsertionToken = 0;
	const name = $derived(getProjectName(session.cwd));
	const repositoryOpen = $derived(desktop ? repositoryPanelOpen : mobilePanel === 'repository');
	const repository = new RepositoryWorkspaceState(untrack(() => session.id), { isOpen: () => repositoryOpen });

	function toggleRepository() {
		if (repositoryOpen) {
			void closeRepository();
			return;
		}
		onRepositoryPanelOpenChange(true);
		if (!desktop) onMobilePanelChange('repository');
	}

	async function closeRepository(): Promise<boolean> {
		if (!await repository.confirmDiscardChanges()) return false;
		onRepositoryPanelOpenChange(false);
		if (!desktop) onMobilePanelChange(undefined);
		repository.clearSelection();
		return true;
	}

	async function openSessionNavigator() {
		if (repositoryOpen) {
			if (!await closeRepository()) return;
		} else if (!await repository.confirmDiscardChanges()) {
			return;
		}
		close();
	}

	async function selectRepositoryItem(selection: RepositorySelection) {
		if (!await repository.selectItem(selection)) return;
		if (selection.kind === 'file') onRepositoryTabChange('files');
		if (!desktop) {
			onRepositoryPanelOpenChange(false);
			onMobilePanelChange(undefined);
		}
	}

	async function editRepositoryFile(path: string) {
		if (!await repository.editFile(path)) return;
		if (!desktop) {
			onRepositoryPanelOpenChange(false);
			onMobilePanelChange(undefined);
		}
	}

	async function createFile(directory: string, name: string) {
		await repository.createFile(directory, name);
		if (!desktop) {
			onRepositoryPanelOpenChange(false);
			onMobilePanelChange(undefined);
		}
	}

	async function insertPathIntoTerminal(entry: WorkspaceEntryDragData) {
		if (!desktop && !await closeRepository()) return;
		pathInsertionRequest = { entries: [entry], token: ++pathInsertionToken };
	}

	async function addDroppedFilesToTerminal(dataTransfer: DataTransfer): Promise<WorkspaceEntryDragData[]> {
		return repository.addFilesForTerminal(await uploadSelectionFromDataTransfer(dataTransfer));
	}

	$effect(() => {
		const sessionId = session.id;
		const presented = !repository.selection;
		// Keep parent activity state out of this effect's dependency graph.
		untrack(() => onTerminalPresentationChange(sessionId, presented));
		return () => untrack(() => onTerminalPresentationChange(sessionId, false));
	});

	$effect(() => {
		if (!repositoryOpen) return;
		const refreshWhenVisible = () => {
			if (!document.hidden) void repository.refresh();
		};
		untrack(() => void repository.refresh());
		document.addEventListener('visibilitychange', refreshWhenVisible);

		return () => {
			document.removeEventListener('visibilitychange', refreshWhenVisible);
		};
	});

	onMount(() => {
		const desktopQuery = window.matchMedia(REPOSITORY_SPLIT_MEDIA_QUERY);
		const syncDesktop = () => desktop = desktopQuery.matches;
		const closeOverlay = (event: KeyboardEvent) => {
			if (event.key !== 'Escape') return;
			if (isUiOverlayOpen()) return;
			const target = event.target instanceof Element ? event.target : undefined;
			if (target?.closest('[data-inline-repository-entry]')) return;
			if (repositoryOpen) {
				if (!target?.closest('.repository-panel')) return;
				event.preventDefault();
				void closeRepository();
			} else if (repository.selection) {
				event.preventDefault();
				void repository.closeViewer();
			}
		};
		syncDesktop();
		desktopQuery.addEventListener('change', syncDesktop);
		window.addEventListener('keydown', closeOverlay, { capture: true });

		return () => {
			desktopQuery.removeEventListener('change', syncDesktop);
			window.removeEventListener('keydown', closeOverlay, { capture: true });
			repository.resolveDiscardChanges(false);
		};
	});
</script>

<section class="workspace-workbench" class:repository-open={repositoryOpen}>
	<div class="workspace-primary">
		<Terminal
			{session}
			{onStartBackground}
			{onStopBackground}
			{onLoadBackgroundOutput}
			{onFavoriteBackground}
			{onRemoveBackgroundFavorite}
			{startingBackground}
			{stoppingBackgroundProcessId}
			{updatingFavoriteCommand}
			{backgroundActionError}
			close={openSessionNavigator}
			{onUpdateNote}
			{onLoadNote}
			{onInputActivity}
			{onOutputActivity}
			{systemMetrics}
			{repositoryOpen}
			isGitRepository={repository.snapshot?.isGitRepository ?? session.isGitRepository}
			changeCount={repository.changeCount}
			worktreeCount={repository.worktreeCount}
			onRepositoryStatus={(changeCount, worktreeCount) => repository.handleStatus(changeCount, worktreeCount)}
			onToggleRepository={toggleRepository}
			{pathInsertionRequest}
			onExternalFileDrop={addDroppedFilesToTerminal}
		>
			{#if repository.selection}
				<RepositoryViewer
					sessionId={session.id}
					selection={repository.selection}
					refreshToken={repository.refreshToken}
					initialFile={repository.openedFile}
					onClose={() => repository.closeViewer()}
					onEditFile={editRepositoryFile}
					onRequestDiscardChange={(path) => repository.requestDiscardChange(path)}
					onFileSaved={(file) => repository.handleFileSaved(file)}
					onFileDirtyChange={(dirty) => repository.fileDirty = dirty}
				/>
			{/if}
		</Terminal>
	</div>

	<RepositoryPanel
		projectName={name}
		snapshot={repository.snapshot}
		loading={repository.loading}
		errorMessage={repository.errorMessage}
		uploading={repository.uploading}
		moving={repository.moving}
		uploadNoticeKind={repository.uploadNoticeKind}
		uploadNotice={repository.uploadNotice}
		selected={repository.selection}
		activeTab={repositoryTab}
		open={repositoryOpen}
		onRefresh={() => void repository.refresh(true)}
		onLoadDirectory={(path) => repository.loadDirectory(path)}
		onCreateFile={createFile}
		onCreateDirectory={(directory, name) => repository.createDirectory(directory, name)}
		onRequestDelete={(path, kind) => repository.requestDelete(path, kind)}
		onRequestDiscardChange={(change) => repository.requestDiscardChange(change)}
		onMoveEntry={(entry, directory) => repository.moveEntry(entry.path, entry.kind, directory)}
		onInsertPath={(entry) => void insertPathIntoTerminal(entry)}
		onUploadSelection={(selection, directory) => repository.uploadFiles(selection, directory)}
		onUploadError={(message) => repository.reportUploadError(message)}
		onClose={closeRepository}
		onSelect={selectRepositoryItem}
		onTabChange={onRepositoryTabChange}
	/>

	{#if repository.discardChangesPrompt}
		<ConfirmDialog
			title="Discard unsaved changes?"
			description="Your edits to the open file have not been saved. Discard them and continue?"
			confirmLabel="Discard changes"
			busyLabel="Discarding…"
			close={() => repository.resolveDiscardChanges(false)}
			onConfirm={async () => repository.resolveDiscardChanges(true)}
		/>
	{/if}

	{#if repository.deleteTarget}
		<ConfirmDialog
			title={repository.deleteTarget.kind === 'directory' ? 'Delete folder?' : 'Delete file?'}
			description={repository.deleteDescription(repository.deleteTarget)}
			confirmLabel={repository.deleteTarget.kind === 'directory' ? 'Delete folder' : 'Delete file'}
			busyLabel="Deleting…"
			close={() => repository.deleteTarget = undefined}
			onConfirm={() => repository.confirmDelete()}
		/>
	{/if}

	{#if repository.uploadConflicts.length > 0}
		<UploadConflictDialog
			count={repository.uploadConflicts.length}
			firstPath={repository.uploadConflicts[0]?.path ?? ''}
			onResolve={(conflict) => repository.resolveUploadConflicts(conflict)}
		/>
	{/if}

	{#if repository.moveConflict}
		<MoveConflictDialog
			path={repository.moveConflict.path}
			kind={repository.moveConflict.kind}
			targetDirectory={repository.moveConflict.targetDirectory}
			onResolve={async (resolution) => { await repository.resolveMoveConflict(resolution); }}
		/>
	{/if}

	{#if repository.discardTarget}
		<ConfirmDialog
			title={repository.discardChangeTitle(repository.discardTarget)}
			description={repository.discardChangeDescription(repository.discardTarget)}
			confirmLabel={repository.discardTarget.status === '??' ? 'Delete file' : 'Discard changes'}
			busyLabel={repository.discardTarget.status === '??' ? 'Deleting…' : 'Discarding…'}
			close={() => repository.discardTarget = undefined}
			onConfirm={() => repository.confirmDiscardChange()}
		/>
	{/if}
</section>

<style>
	.workspace-workbench, .workspace-primary { width: 100%; min-width: 0; min-height: 0; }
	.workspace-workbench { position: relative; height: 100dvh; overflow: hidden; }
	.workspace-primary { position: relative; height: 100%; }

	@media (min-width: 80rem) {
		.workspace-workbench.repository-open .workspace-primary { width: auto; margin-right: 22rem; }
	}

</style>
