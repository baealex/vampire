<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import Terminal from '$lib/Terminal.svelte';
	import type { ManagedSession, MobilePanel } from '$lib/session/types';
	import { projectName as getProjectName } from '$lib/session/view';
	import type { SystemMetrics } from '$lib/system-metrics';
	import ConfirmDialog from '$lib/ConfirmDialog.svelte';
	import { REPOSITORY_SPLIT_MEDIA_QUERY } from '$lib/ui/layout';
	import { isUiOverlayOpen } from '$lib/ui/overlay';
	import RepositoryPanel from './RepositoryPanel.svelte';
	import RepositoryViewer from './RepositoryViewer.svelte';
	import { RepositoryWorkspaceState } from './workspace-state.svelte';
	import type { RepositorySelection, RepositoryTab } from './types';

	let {
		session,
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

	$effect(() => {
		const sessionId = session.id;
		const presented = !repository.selection;
		onTerminalPresentationChange(sessionId, presented);
		return () => onTerminalPresentationChange(sessionId, false);
	});

	$effect(() => {
		if (!repositoryOpen) return;
		const refreshWhenVisible = () => {
			if (!document.hidden) void repository.refresh();
		};
		void repository.refresh();
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
		>
			{#if repository.selection}
				<RepositoryViewer
					sessionId={session.id}
					selection={repository.selection}
					refreshToken={repository.refreshToken}
					initialFile={repository.openedFile}
					onClose={() => repository.closeViewer()}
					onEditFile={editRepositoryFile}
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
		selected={repository.selection}
		activeTab={repositoryTab}
		open={repositoryOpen}
		onRefresh={() => void repository.refresh(true)}
		onLoadDirectory={(path) => repository.loadDirectory(path)}
		onCreateFile={createFile}
		onCreateDirectory={(directory, name) => repository.createDirectory(directory, name)}
		onRequestDelete={(path, kind) => repository.requestDelete(path, kind)}
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
