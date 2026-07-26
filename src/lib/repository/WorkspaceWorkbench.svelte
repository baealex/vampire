<script lang="ts">
	import { onMount } from 'svelte';
	import Terminal from '$lib/Terminal.svelte';
	import type { ManagedSession, MobilePanel } from '$lib/session/types';
	import { projectName as getProjectName } from '$lib/session/view';
	import type { SystemMetrics } from '$lib/system-metrics';
	import RepositoryPanel from './RepositoryPanel.svelte';
	import RepositoryViewer from './RepositoryViewer.svelte';
	import type { RepositorySelection, RepositorySnapshot } from './types';

	let {
		session,
		close,
		onUpdateNote,
		onInputActivity,
		onOutputActivity,
		systemMetrics,
		mobilePanel,
		onMobilePanelChange = () => undefined
	}: {
		session: ManagedSession;
		close: () => void;
		onUpdateNote: (sessionId: string, note: string) => Promise<void>;
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
	let desktopRepositoryOpen = $state(false);
	let desktop = $state(false);
	let refreshInFlight = false;
	const name = $derived(getProjectName(session.cwd));
	let changeCount = $state(0);
	const repositoryOpen = $derived(desktop ? desktopRepositoryOpen : mobilePanel === 'repository');

	async function refreshRepository(showLoading = false) {
		if (refreshInFlight || document.hidden) return;
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
			snapshot = await response.json() as RepositorySnapshot;
			changeCount = snapshot.changes.length;
			repositoryError = '';
			repositoryRefreshToken += 1;
		} catch (error) {
			repositoryError = error instanceof Error ? error.message : 'Unable to refresh this repository.';
		} finally {
			if (shouldShowLoading) repositoryLoading = false;
			refreshInFlight = false;
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
		if (desktop) desktopRepositoryOpen = false;
		else onMobilePanelChange(undefined);
		selection = undefined;
	}

	function openSessionNavigator() {
		closeRepository();
		close();
	}

	function selectRepositoryItem(nextSelection: RepositorySelection) {
		selection = nextSelection;
		if (!desktop) onMobilePanelChange(undefined);
	}

	$effect(() => {
		if (!repositoryOpen) return;
		const refreshWhenVisible = () => {
			if (!document.hidden) void refreshRepository();
		};
		void refreshRepository();
		document.addEventListener('visibilitychange', refreshWhenVisible);
		const interval = window.setInterval(refreshWhenVisible, 2_000);

		return () => {
			document.removeEventListener('visibilitychange', refreshWhenVisible);
			window.clearInterval(interval);
		};
	});

	onMount(() => {
		const desktopQuery = window.matchMedia('(min-width: 64rem)');
		const syncDesktop = () => desktop = desktopQuery.matches;
		const closeOverlay = (event: KeyboardEvent) => {
			if (event.key !== 'Escape') return;
			if (repositoryOpen) {
				event.preventDefault();
				closeRepository();
			} else if (selection) {
				event.preventDefault();
				selection = undefined;
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
			{onInputActivity}
			{onOutputActivity}
			{systemMetrics}
			{repositoryOpen}
			{changeCount}
			onRepositoryStatus={(nextChangeCount) => changeCount = nextChangeCount}
			onToggleRepository={toggleRepository}
		>
			{#if selection}
				<RepositoryViewer
					sessionId={session.id}
					{selection}
					refreshToken={repositoryRefreshToken}
					onClose={() => selection = undefined}
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
		onClose={closeRepository}
		onSelect={selectRepositoryItem}
	/>
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
