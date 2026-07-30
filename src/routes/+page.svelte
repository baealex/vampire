<script lang="ts">
	import { dev } from '$app/environment';
	import { pushState } from '$app/navigation';
	import { onMount } from 'svelte';
	import CircleHelp from '@lucide/svelte/icons/circle-help';
	import Keyboard from '@lucide/svelte/icons/keyboard';
	import PanelLeft from '@lucide/svelte/icons/panel-left';
	import SquareTerminal from '@lucide/svelte/icons/square-terminal';
	import LoginScreen from '$lib/LoginScreen.svelte';
	import TmuxSetupScreen from '$lib/TmuxSetupScreen.svelte';
	import Spinner from '$lib/ui/Spinner.svelte';
	import { isUiOverlayOpen } from '$lib/ui/overlay';
	import { WorkspaceConnectionState } from '$lib/app/workspace-connection-state.svelte';
	import WorkspaceWorkbench from '$lib/repository/WorkspaceWorkbench.svelte';
	import type { RepositoryTab } from '$lib/repository/types';
	import SessionNavigator from '$lib/session/SessionNavigator.svelte';
	import { SessionWorkspaceState } from '$lib/session/workspace-state.svelte';
	import type { ManagedSession, MobilePanel } from '$lib/session/types';
	import { projectName } from '$lib/session/view';
	import { REPOSITORY_SPLIT_MEDIA_QUERY } from '$lib/ui/layout';

	let { initialSessionId = undefined }: { initialSessionId?: string } = $props();

	let mobilePanel = $state<MobilePanel | undefined>(undefined);
	let repositoryPanelOpen = $state(false);
	let repositoryTab = $state<RepositoryTab>('changes');
	let presentedTerminalSessionId = $state<string | undefined>(undefined);
	let sessionShortcutModifier = $state('Ctrl');
	let previewTmuxUnavailable = $state(false);
	let useMetaSessionShortcuts = false;
	const REPOSITORY_TAB_KEY = 'vampire:repository-tab';

	const connection = new WorkspaceConnectionState();
	const tmuxStatus = $derived(
		connection.tmuxStatus && previewTmuxUnavailable
			? { ...connection.tmuxStatus, available: false, version: null }
			: connection.tmuxStatus
	);
	const workspace: SessionWorkspaceState = new SessionWorkspaceState({
		navigate: (path) => pushState(path, {}),
		onUnauthorized: () => connection.markUnauthenticated(),
		isSessionObserved: (sessionId) => terminalIsObserved(sessionId)
	});

	function terminalIsObserved(sessionId: string): boolean {
		return workspace.requestedSessionId === sessionId
			&& presentedTerminalSessionId === sessionId
			&& document.visibilityState === 'visible'
			&& mobilePanel === undefined;
	}

	function setTerminalPresentation(sessionId: string, presented: boolean) {
		if (presented) {
			presentedTerminalSessionId = sessionId;
			markActiveSessionObserved();
			return;
		}
		if (presentedTerminalSessionId !== sessionId) return;
		if (terminalIsObserved(sessionId)) workspace.markSessionObserved(sessionId);
		presentedTerminalSessionId = undefined;
	}

	function markActiveSessionObserved() {
		if (workspace.requestedSessionId && terminalIsObserved(workspace.requestedSessionId)) {
			workspace.markSessionObserved(workspace.requestedSessionId);
		}
	}

	function setMobilePanel(panel: MobilePanel | undefined) {
		if (mobilePanel === undefined && panel !== undefined) markActiveSessionObserved();
		mobilePanel = panel;
		if (panel === undefined) markActiveSessionObserved();
	}

	function setRepositoryPanelOpen(open: boolean) {
		repositoryPanelOpen = open;
		if (!open && mobilePanel === 'repository') setMobilePanel(undefined);
	}

	function setRepositoryTab(tab: RepositoryTab) {
		repositoryTab = tab;
		window.localStorage.setItem(REPOSITORY_TAB_KEY, tab);
	}

	function isRepositorySplitViewport(): boolean {
		return window.matchMedia(REPOSITORY_SPLIT_MEDIA_QUERY).matches;
	}

	function restorePanelAfterWorkspaceChange() {
		setMobilePanel(repositoryPanelOpen && !isRepositorySplitViewport() ? 'repository' : undefined);
	}

	function unlock() {
		return connection.unlock();
	}

	async function logout() {
		if (!await connection.logout()) return;
		workspace.reset();
		repositoryPanelOpen = false;
		mobilePanel = 'sessions';
		pushState('/', {});
	}

	function openSession(session: ManagedSession) {
		workspace.openSession(session);
		restorePanelAfterWorkspaceChange();
	}

	async function createSession() {
		if (await workspace.createSession(tmuxStatus?.available)) restorePanelAfterWorkspaceChange();
	}

	function clearActiveSession() {
		mobilePanel = 'sessions';
		workspace.clearActiveSession();
	}

	function openSessionNavigator() {
		mobilePanel = 'sessions';
	}

	function closeSessionNavigator() {
		if (workspace.hasOpenSession) restorePanelAfterWorkspaceChange();
	}

	function syncSessionFromLocation(pathname = location.pathname) {
		workspace.syncLocation(pathname);
		if (workspace.requestedSessionId) restorePanelAfterWorkspaceChange();
		else mobilePanel = 'sessions';
		markActiveSessionObserved();
	}

	async function restartSession(session: ManagedSession) {
		await workspace.restartSession(session);
	}

	async function closeSession(session: ManagedSession): Promise<{ ok: boolean; error?: string }> {
		const wasActive = workspace.requestedSessionId === session.id;
		if (!await workspace.closeSession(session)) return { ok: false, error: workspace.sessionActionError };
		if (wasActive) mobilePanel = 'sessions';
		return { ok: true };
	}

	async function removeSession(session: ManagedSession): Promise<{ ok: boolean; error?: string }> {
		const wasActive = workspace.requestedSessionId === session.id;
		if (!await workspace.removeSession(session)) return { ok: false, error: workspace.sessionActionError };
		if (wasActive) mobilePanel = 'sessions';
		return { ok: true };
	}

	function handleSessionShortcut(event: KeyboardEvent) {
		const digitMatch = /^(?:Digit|Numpad)(\d)$/.exec(event.code);
		if (event.defaultPrevented || event.repeat || event.isComposing || event.shiftKey || !digitMatch) return;
		if (isUiOverlayOpen()) return;
		const primaryModifier = useMetaSessionShortcuts
			? event.metaKey && !event.ctrlKey
			: event.ctrlKey && !event.metaKey;
		const fallbackModifier = event.altKey && !event.metaKey && !event.ctrlKey;
		if (!primaryModifier && !fallbackModifier) return;

		const digit = digitMatch[1];
		const index = digit === '0' ? 9 : Number(digit) - 1;
		const targetSession = workspace.displayedSessions[index];
		if (!targetSession) return;
		event.preventDefault();
		event.stopPropagation();
		openSession(targetSession);
	}

	function handleOverlayKeydown(event: KeyboardEvent) {
		if (event.key !== 'Escape') return;
		if (isUiOverlayOpen()) return;
		if (mobilePanel === 'sessions' && workspace.hasOpenSession) {
			event.preventDefault();
			closeSessionNavigator();
		}
	}

	onMount(() => {
		const initialSessionPath = initialSessionId ? `/sessions/${encodeURIComponent(initialSessionId)}` : '/';
		syncSessionFromLocation(location.pathname || initialSessionPath);
		previewTmuxUnavailable = dev && new URLSearchParams(location.search).get('preview') === 'tmux';
		useMetaSessionShortcuts = /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
		sessionShortcutModifier = useMetaSessionShortcuts ? '⌘' : 'Ctrl+';
		workspace.restoreBrowserPreferences(window.localStorage);
		const savedRepositoryTab = window.localStorage.getItem(REPOSITORY_TAB_KEY);
		if (savedRepositoryTab === 'changes' || savedRepositoryTab === 'files') repositoryTab = savedRepositoryTab;
		const stopConnection = connection.start({
			refreshSessions: (options) => workspace.refresh(options),
			onVisible: markActiveSessionObserved,
			onSessionEvent: (event) => {
				if (event.type === 'sessions-snapshot') workspace.applySessionSnapshot(event.sessions);
				else if (event.type === 'session-added') workspace.applySessionAdded(event.session);
				else if (event.type === 'session-updated') workspace.applySessionUpdated(event.id, event.changes);
				else workspace.applySessionRemoved(event.id);
			}
		});
		const handlePopState = () => syncSessionFromLocation();
		const handleVisibilityChange = () => {
			const requestedSessionId = workspace.requestedSessionId;
			if (
				document.hidden
				&& requestedSessionId
				&& requestedSessionId === presentedTerminalSessionId
				&& mobilePanel === undefined
			) {
				workspace.markSessionObserved(requestedSessionId);
			} else if (!document.hidden) {
				markActiveSessionObserved();
			}
		};
		window.addEventListener('popstate', handlePopState);
		window.addEventListener('keydown', handleSessionShortcut, { capture: true });
		window.addEventListener('keydown', handleOverlayKeydown, { capture: true });
		document.addEventListener('visibilitychange', handleVisibilityChange);

		return () => {
			stopConnection();
			workspace.dispose();
			window.removeEventListener('popstate', handlePopState);
			window.removeEventListener('keydown', handleSessionShortcut, { capture: true });
			window.removeEventListener('keydown', handleOverlayKeydown, { capture: true });
			document.removeEventListener('visibilitychange', handleVisibilityChange);
		};
	});
</script>

<svelte:head>
	<meta name="description" content="A self-hosted browser workspace for persistent tmux sessions." />
</svelte:head>

<main class:terminal-open={workspace.hasOpenSession}>
	{#if connection.checking}
		<section class="loading-state" aria-live="polite">
			<Spinner />
			Connecting…
		</section>
	{:else if tmuxStatus?.available === false}
		<TmuxSetupScreen status={tmuxStatus} />
	{:else if connection.authenticationRequired && !connection.authenticated}
		<LoginScreen
			token={connection.token}
			error={connection.loginError}
			onTokenChange={(token) => connection.token = token}
			onSubmit={() => void unlock()}
		/>
	{:else}
		<div class="dashboard" class:terminal-open={workspace.hasOpenSession}>
			<SessionNavigator
				sessions={workspace.sessions}
				displayedSessions={workspace.displayedSessions}
				selectedSessionId={workspace.activeSession?.id}
				activityRecords={workspace.activityRecords}
				authenticationRequired={connection.authenticationRequired}
				hasOpenSession={workspace.hasOpenSession}
				mobileOpen={mobilePanel === 'sessions'}
				errorMessage={workspace.errorMessage || connection.errorMessage}
				sessionOrderMode={workspace.sessionOrderMode}
				bind:newSessionOpen={workspace.newSessionOpen}
				bind:cwd={workspace.cwd}
				starting={workspace.starting}
				startError={workspace.startError}
				tmuxAvailable={tmuxStatus?.available}
				onLogout={() => void logout()}
				onClose={closeSessionNavigator}
				onOrderModeChange={(mode) => workspace.setSessionOrderMode(mode)}
				onReorder={(draggedId, targetId, position) => workspace.reorderSession(draggedId, targetId, position)}
				onOpen={openSession}
				sessionAction={workspace.sessionAction}
				onCloseSession={closeSession}
				onRemoveSession={removeSession}
				onCreate={() => void createSession()}
			/>

			{#if workspace.activeSession?.state === 'missing'}
				<section class="unavailable-sheet" aria-labelledby="ended-session-title">
					<header class="unavailable-header">
						<button class="detail-back" onclick={openSessionNavigator} aria-label="Open workspaces">
							<PanelLeft size={18} strokeWidth={1.8} aria-hidden="true" />
							<span>Workspaces</span>
						</button>
						<div class="unavailable-identity">
							<strong>{projectName(workspace.activeSession.cwd)}</strong>
							<span title={workspace.activeSession.cwd}>{workspace.activeSession.cwd}</span>
						</div>
						<span class="ended-badge">Ended</span>
					</header>
					<div class="unavailable-body">
						<span class="unavailable-icon" aria-hidden="true"><SquareTerminal size={22} strokeWidth={1.7} /></span>
						<p class="section-label">tmux session unavailable</p>
						<h2 id="ended-session-title">This shell has ended</h2>
						<p>The process is no longer running. You can open a fresh shell in the same project or remove this workspace from the list.</p>
						<code>{workspace.activeSession.cwd}</code>
						<div class="unavailable-actions">
							<button class="primary-button" onclick={() => void restartSession(workspace.activeSession!)} disabled={Boolean(workspace.sessionAction)}>
								{workspace.sessionAction === 'restart' ? 'Reopening…' : 'Reopen shell'}
							</button>
							<button class="remove-button" onclick={() => void removeSession(workspace.activeSession!)} disabled={Boolean(workspace.sessionAction)}>
								{workspace.sessionAction === 'remove' ? 'Removing…' : 'Remove workspace'}
							</button>
						</div>
						{#if workspace.sessionActionError}<p class="error" role="alert">{workspace.sessionActionError}</p>{/if}
					</div>
				</section>
			{:else if workspace.activeSession}
				{#key workspace.activeSession.id}
					<WorkspaceWorkbench
						session={workspace.activeSession}
						close={openSessionNavigator}
						onUpdateNote={(sessionId, note) => workspace.updateSessionNote(sessionId, note)}
						onLoadNote={(sessionId) => workspace.loadSessionNote(sessionId)}
						onInputActivity={(sessionId, timestamp) => workspace.recordSessionInput(sessionId, timestamp)}
						onOutputActivity={(sessionId, active, timestamp) => workspace.recordSessionOutput(sessionId, active, timestamp, terminalIsObserved(sessionId))}
						onTerminalPresentationChange={setTerminalPresentation}
						{mobilePanel}
						onMobilePanelChange={setMobilePanel}
						repositoryPanelOpen={repositoryPanelOpen}
						onRepositoryPanelOpenChange={setRepositoryPanelOpen}
						repositoryTab={repositoryTab}
						onRepositoryTabChange={setRepositoryTab}
						systemMetrics={connection.systemMetrics}
					/>
				{/key}
			{:else if workspace.requestedSessionId && workspace.sessionsLoaded}
				<section class="unavailable-sheet" aria-labelledby="missing-session-title">
					<header class="unavailable-header">
						<button class="detail-back" onclick={openSessionNavigator} aria-label="Open workspaces">
							<PanelLeft size={18} strokeWidth={1.8} aria-hidden="true" />
							<span>Workspaces</span>
						</button>
					</header>
					<div class="unavailable-body">
						<span class="unavailable-icon" aria-hidden="true"><CircleHelp size={22} strokeWidth={1.7} /></span>
						<h2 id="missing-session-title">Workspace not found</h2>
						<p>This workspace is no longer registered on this Vampire server.</p>
						<button class="secondary-button" onclick={openSessionNavigator}>Open workspaces</button>
					</div>
				</section>
			{:else}
				<section class="empty-workbench" aria-labelledby="empty-workbench-title">
					<span class="empty-workbench__prompt" aria-hidden="true"><SquareTerminal size={26} strokeWidth={1.5} /></span>
					<h2 id="empty-workbench-title">Select a workspace</h2>
					<p>Choose a workspace from the sidebar or start a new one.</p>
					<p class="empty-workbench__shortcut"><Keyboard size={14} strokeWidth={1.7} aria-hidden="true" /> {sessionShortcutModifier}1–0 · Alt+1–0</p>
				</section>
			{/if}
		</div>
	{/if}
</main>

<style>
	main { width: 100%; min-height: 100dvh; }
	.dashboard { min-width: 0; min-height: 100dvh; padding: max(1rem, env(safe-area-inset-top)) 1rem max(1rem, env(safe-area-inset-bottom)); }
	.primary-button, .secondary-button { min-height: var(--control-height-lg); padding: 0 1rem; border: 0; border-radius: var(--radius-sm); font-size: var(--text-label); font-weight: var(--weight-medium); cursor: pointer; }
	.primary-button { background: var(--color-accent); color: var(--color-accent-ink); }
	.primary-button:hover { background: var(--color-accent-hover); }
	.primary-button:disabled { cursor: wait; opacity: 0.65; }
	.secondary-button { background: var(--color-surface-raised); color: var(--color-text); }
	.error { margin: 0; color: var(--color-danger); font-size: var(--text-label); line-height: var(--leading-ui); }
	.loading-state { display: flex; align-items: center; justify-content: center; gap: 0.7rem; min-height: 100dvh; color: var(--color-text-secondary); }
	.unavailable-sheet { position: fixed; z-index: 20; inset: 0; display: grid; grid-template-rows: auto minmax(0, 1fr); overflow: hidden; background: var(--color-terminal-background); color: var(--color-text); }
	.unavailable-header { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 0.75rem; min-width: 0; padding: max(0.65rem, env(safe-area-inset-top)) max(0.75rem, env(safe-area-inset-right)) 0.65rem max(0.75rem, env(safe-area-inset-left)); border-bottom: 1px solid var(--color-border-subtle); background: var(--color-panel); }
	.detail-back { display: inline-flex; align-items: center; gap: 0.25rem; min-height: 2.65rem; padding: 0 0.65rem 0 0.45rem; border: 1px solid var(--color-border); border-radius: 0.55rem; background: var(--color-control-background); color: var(--color-text); font: inherit; font-weight: var(--weight-medium); cursor: pointer; }
	.detail-back:hover { background: var(--color-surface-hover); }
	.unavailable-identity { display: grid; min-width: 0; justify-items: center; gap: 0.18rem; }
	.unavailable-identity strong, .unavailable-identity span { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.unavailable-identity strong { font-size: var(--text-body); font-weight: var(--weight-medium); }
	.unavailable-identity span { color: var(--color-text-tertiary); font-family: ui-monospace, monospace; font-size: var(--text-caption); }
	.ended-badge { padding: 0.28rem 0.5rem; border-radius: var(--radius-pill); background: var(--color-surface-raised); color: var(--color-text-secondary); font-size: var(--text-caption); font-weight: var(--weight-medium); }
	.unavailable-body { display: flex; flex-direction: column; align-items: flex-start; justify-content: center; width: min(100%, 32rem); min-height: 0; margin: 0 auto; padding: 2rem 1.25rem max(2rem, env(safe-area-inset-bottom)); }
	.unavailable-icon { display: grid; place-items: center; width: 3rem; height: 3rem; margin-bottom: 1.25rem; border: 1px solid var(--color-border); border-radius: 0.8rem; background: var(--color-surface); color: var(--color-accent); }
	.unavailable-body h2 { margin: 0.3rem 0 0; font-size: var(--text-display); font-weight: var(--weight-strong); line-height: var(--leading-tight); }
	.unavailable-body > p:not(.section-label):not(.error) { margin: 0.75rem 0 1rem; overflow-wrap: anywhere; color: var(--color-text-secondary); font-size: var(--text-body); line-height: var(--leading-body); }
	.unavailable-body code { display: block; width: 100%; overflow: hidden; margin-bottom: 1.25rem; padding: 0.75rem; border: 1px solid var(--color-border-subtle); border-radius: 0.55rem; background: var(--color-panel); color: var(--color-text-secondary); font-size: var(--text-caption); text-overflow: ellipsis; white-space: nowrap; }
	.unavailable-actions { display: flex; flex-wrap: wrap; gap: 0.65rem; width: 100%; }
	.unavailable-actions button { flex: 1 1 10rem; }
	.remove-button { min-height: var(--control-height-lg); padding: 0 1rem; border: 1px solid var(--color-danger-border); border-radius: var(--radius-sm); background: transparent; color: var(--color-danger-text); font-size: var(--text-label); font-weight: var(--weight-medium); cursor: pointer; }
	.remove-button:hover { background: var(--color-danger-surface-hover); }
	.remove-button:disabled { cursor: wait; opacity: 0.6; }
	.unavailable-body .error { margin-top: 0.9rem; }
	.empty-workbench { display: none; }
	@media (min-width: 64rem) {
		main { height: 100dvh; overflow: hidden; }
		.dashboard { display: grid; grid-template-columns: 20rem minmax(0, 1fr); align-items: stretch; gap: 0; height: 100%; min-height: 0; padding: 0; }
		.empty-workbench { display: flex; flex-direction: column; align-items: center; justify-content: center; min-width: 0; background: var(--color-terminal-background); color: var(--color-text-tertiary); }
		.empty-workbench__prompt { margin-bottom: 0.9rem; color: var(--color-text-disabled); }
		.empty-workbench h2 { margin: 0; color: var(--color-text-tertiary); font-size: var(--text-title); font-weight: var(--weight-medium); line-height: var(--leading-tight); }
		.empty-workbench p { margin: 0.45rem 0 0; font-size: var(--text-caption); }
		.empty-workbench .empty-workbench__shortcut { display: flex; align-items: center; gap: 0.4rem; margin-top: 0.9rem; color: var(--color-text-disabled); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--text-caption); }
		.unavailable-sheet { position: relative; z-index: 1; inset: auto; height: 100dvh; min-height: 0; border: 0; border-radius: 0; }
	}
	@media (max-width: 32rem) {
		.unavailable-header { grid-template-columns: 2.65rem minmax(0, 1fr) auto; }
		.detail-back { width: 2.65rem; padding: 0; justify-content: center; }
		.detail-back span { display: none; }
	}
</style>
