<script lang="ts">
	import Plus from '@lucide/svelte/icons/plus';
	import SessionList from './SessionList.svelte';
	import SessionNavigatorHeader from './SessionNavigatorHeader.svelte';
	import WorkspaceDirectoryPicker from './WorkspaceDirectoryPicker.svelte';
	import type { ManagedSession, SessionOrderMode } from './types';
	import type { SessionActivityRecords } from './view';

	let {
		sessions,
		displayedSessions,
		selectedSessionId,
		activityRecords,
		authenticationRequired,
		hasOpenSession,
		mobileOpen,
		errorMessage,
		sessionOrderMode,
		newSessionOpen = $bindable(),
		cwd = $bindable(),
		starting,
		startError,
		tmuxAvailable,
		onLogout,
		onClose,
		onOrderModeChange,
		onReorder,
		onOpen,
		sessionAction,
		onCloseSession,
		onRemoveSession,
		onCreate
	}: {
		sessions: ManagedSession[];
		displayedSessions: ManagedSession[];
		selectedSessionId?: string;
		activityRecords: SessionActivityRecords;
		authenticationRequired: boolean;
		hasOpenSession: boolean;
		mobileOpen: boolean;
		errorMessage: string;
		sessionOrderMode: SessionOrderMode;
		newSessionOpen: boolean;
		cwd: string;
		starting: boolean;
		startError: string;
		tmuxAvailable?: boolean;
		onLogout: () => void;
		onClose: () => void;
		onOrderModeChange: (mode: SessionOrderMode) => void;
		onReorder: (draggedId: string, targetId: string, position: 'before' | 'after') => void;
		onOpen: (session: ManagedSession) => void;
		sessionAction?: 'restart' | 'close' | 'remove';
		onCloseSession: (session: ManagedSession) => Promise<{ ok: boolean; error?: string }>;
		onRemoveSession: (session: ManagedSession) => Promise<{ ok: boolean; error?: string }>;
		onCreate: () => void;
	} = $props();

	function openNewSession() {
		newSessionOpen = true;
	}

	function createWorkspace(path: string) {
		cwd = path;
		onCreate();
	}
</script>

{#if mobileOpen && hasOpenSession}
	<button class="session-scrim" type="button" aria-label="Close workspaces" onclick={onClose}></button>
{/if}

<div class="session-column" class:mobile-open={mobileOpen} class:standalone={!hasOpenSession}>
	<section class="session-panel" aria-labelledby="workspaces-title">
		<SessionNavigatorHeader
			sessionCount={sessions.length}
			{authenticationRequired}
			{hasOpenSession}
			{sessionOrderMode}
			{onLogout}
			{onClose}
			{onOrderModeChange}
		/>
		<SessionList
			{sessions}
			{displayedSessions}
			{selectedSessionId}
			{activityRecords}
			{errorMessage}
			{sessionOrderMode}
			{onReorder}
			{onOpen}
			{sessionAction}
			{onCloseSession}
			{onRemoveSession}
			onNewSession={openNewSession}
		/>
	</section>

	<section class="new-session-panel" aria-labelledby="new-workspace-title">
		<button class="new-session-toggle" type="button" onclick={openNewSession}>
			<span class="new-session-toggle__icon" aria-hidden="true"><Plus size={18} strokeWidth={2.3} /></span>
			<strong id="new-workspace-title">New workspace</strong>
		</button>
	</section>

	{#if newSessionOpen}
		<WorkspaceDirectoryPicker
			initialPath={cwd}
			starting={starting}
			startError={startError}
			tmuxAvailable={tmuxAvailable}
			close={() => newSessionOpen = false}
			onCreate={createWorkspace}
		/>
	{/if}
</div>

<style>
	.session-column { display: grid; grid-template-columns: minmax(0, 1fr) 20rem; align-items: start; gap: 1.25rem; min-width: 0; }
	.session-scrim { display: none; }
	.session-panel, .new-session-panel { border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-surface); }
	.session-panel { min-width: 0; overflow: hidden; }
	.new-session-panel { overflow: hidden; }
	.new-session-toggle { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 0.8rem; width: 100%; min-height: 4.6rem; padding: 0.9rem 1rem; border: 0; background: transparent; color: inherit; text-align: left; cursor: pointer; }
	.new-session-toggle:hover { background: var(--color-surface-raised); }
	.new-session-toggle__icon { display: grid; place-items: center; width: 2rem; height: 2rem; border-radius: 50%; background: var(--color-accent); color: var(--color-accent-ink); }
	.new-session-toggle strong { font-size: var(--text-body); font-weight: var(--weight-medium); }

	@media (min-width: 64rem) {
		.session-column { display: flex; flex-direction: column; gap: 0; min-width: 0; height: 100%; overflow: hidden; border-right: 1px solid var(--color-border); background: var(--color-panel); }
		.session-panel, .new-session-panel { width: 100%; border: 0; border-radius: 0; background: transparent; }
		.session-panel { display: flex; flex: 1 1 auto; flex-direction: column; min-height: 0; }
		.new-session-panel { position: relative; z-index: 1; flex: 0 0 auto; border-top: 1px solid var(--color-border); background: var(--color-panel); }
	}

	@media (max-width: 63.999rem) {
		.session-scrim { position: fixed; z-index: 39; inset: 0; display: block; padding: 0; border: 0; background: var(--color-backdrop); cursor: pointer; animation: session-scrim-in 180ms ease; }
		.session-column { position: fixed; z-index: 40; inset: 0 auto 0 0; display: flex; flex-direction: column; align-items: stretch; gap: 0; width: min(23rem, calc(100% - 2.75rem)); height: 100dvh; padding: env(safe-area-inset-top) 0 env(safe-area-inset-bottom); overflow-y: auto; transform: translateX(-100%); border-right: 1px solid var(--color-border-strong); background: var(--color-panel); box-shadow: var(--shadow-navigation-panel); pointer-events: none; transition: transform 180ms ease, visibility 0s linear 180ms; visibility: hidden; }
		.session-column.standalone { width: 100%; }
		.session-column.mobile-open { transform: translateX(0); pointer-events: auto; transition: transform 180ms ease; visibility: visible; }
		.session-panel, .new-session-panel { width: 100%; border: 0; border-radius: 0; background: transparent; }
		.session-panel { display: flex; flex: 1 1 auto; flex-direction: column; min-height: 0; }
		.new-session-panel { position: relative; z-index: 1; flex: 0 0 auto; border-top: 1px solid var(--color-border); background: var(--color-panel); }
	}

	@media (prefers-reduced-motion: reduce) {
		.session-column { transition: none; }
		.session-scrim { animation: none; }
	}

	@keyframes session-scrim-in { from { opacity: 0; } }
</style>
