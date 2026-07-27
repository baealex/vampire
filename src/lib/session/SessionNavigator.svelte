<script lang="ts">
	import { tick } from 'svelte';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	import GripVertical from '@lucide/svelte/icons/grip-vertical';
	import LogOut from '@lucide/svelte/icons/log-out';
	import Plus from '@lucide/svelte/icons/plus';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import SquareTerminal from '@lucide/svelte/icons/square-terminal';
	import StickyNote from '@lucide/svelte/icons/sticky-note';
	import X from '@lucide/svelte/icons/x';
	import ThemeToggle from '$lib/theme/ThemeToggle.svelte';
	import type { ManagedSession, SessionOrderMode } from './types';
	import {
		formatSessionTimestamp,
		latestSessionOutputAt,
		projectName,
		sessionActivityHint,
		sessionActivityState,
		sessionProcessColor,
		sessionProcess,
		sessionProcessHint
	} from './view';

	let {
		sessions,
		displayedSessions,
		activeSessionId,
		activeOutputSessionId,
		unreadSessionIds,
		authenticationRequired,
		hasOpenSession,
		mobileOpen,
		loading,
		errorMessage,
		sessionOrderMode,
		newSessionOpen = $bindable(),
		cwd = $bindable(),
		starting,
		startError,
		tmuxAvailable,
		onRefresh,
		onLogout,
		onClose,
		onOrderModeChange,
		onReorder,
		onOpen,
		onOpenActions,
		onCreate
	}: {
		sessions: ManagedSession[];
		displayedSessions: ManagedSession[];
		activeSessionId?: string;
		activeOutputSessionId?: string;
		unreadSessionIds: Set<string>;
		authenticationRequired: boolean;
		hasOpenSession: boolean;
		mobileOpen: boolean;
		loading: boolean;
		errorMessage: string;
		sessionOrderMode: SessionOrderMode;
		newSessionOpen: boolean;
		cwd: string;
		starting: boolean;
		startError: string;
		tmuxAvailable?: boolean;
		onRefresh: () => void;
		onLogout: () => void;
		onClose: () => void;
		onOrderModeChange: (mode: SessionOrderMode) => void;
		onReorder: (draggedId: string, targetId: string, position: 'before' | 'after') => void;
		onOpen: (session: ManagedSession) => void;
		onOpenActions: (session: ManagedSession, trigger: HTMLElement) => void;
		onCreate: () => void;
	} = $props();

	let cwdInput = $state<HTMLInputElement>();
	let draggedSessionId = $state<string>();
	let dragOverSessionId = $state<string>();
	let dropPosition = $state<'before' | 'after'>('before');

	$effect(() => {
		if (newSessionOpen) void tick().then(() => cwdInput?.focus());
	});

	function openNewSession() {
		newSessionOpen = true;
	}

	function beginSessionDrag(event: DragEvent, sessionId: string) {
		if (sessionOrderMode !== 'manual' || !event.dataTransfer) return;
		draggedSessionId = sessionId;
		event.dataTransfer.effectAllowed = 'move';
		event.dataTransfer.setData('text/plain', sessionId);
	}

	function updateSessionDropTarget(event: DragEvent, sessionId: string) {
		if (!draggedSessionId || draggedSessionId === sessionId) return;
		event.preventDefault();
		if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
		const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
		dragOverSessionId = sessionId;
		dropPosition = event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after';
	}

	function dropSession(event: DragEvent, sessionId: string) {
		event.preventDefault();
		if (draggedSessionId) onReorder(draggedSessionId, sessionId, dropPosition);
		endSessionDrag();
	}

	function endSessionDrag() {
		draggedSessionId = undefined;
		dragOverSessionId = undefined;
	}

	function handleSessionOrderKeydown(event: KeyboardEvent, sessionId: string) {
		if (sessionOrderMode !== 'manual' || !event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
		event.preventDefault();
		const index = displayedSessions.findIndex((session) => session.id === sessionId);
		const target = displayedSessions[index + (event.key === 'ArrowUp' ? -1 : 1)];
		if (target) onReorder(sessionId, target.id, event.key === 'ArrowUp' ? 'before' : 'after');
	}

	function handleSessionContextMenu(event: MouseEvent, session: ManagedSession) {
		event.preventDefault();
		onOpenActions(session, event.currentTarget as HTMLElement);
	}
</script>

<div class="session-column" class:mobile-open={mobileOpen}>
	<section class="session-panel" aria-labelledby="workspaces-title">
		<header class="section-header">
			<div class="session-panel-title">
				<h1 id="workspaces-title">Workspaces</h1>
				<span class="session-count" aria-label={`${sessions.length} workspaces`}>{sessions.length}</span>
			</div>
			<div class="section-actions">
				<ThemeToggle />
				<button class="icon-button" class:spinning={loading} onclick={onRefresh} disabled={loading} aria-label="Refresh workspaces" title="Refresh workspaces">
					<RefreshCw size={18} strokeWidth={1.8} aria-hidden="true" />
				</button>
				{#if authenticationRequired}
					<button class="icon-button" onclick={onLogout} aria-label="Sign out" title="Sign out">
						<LogOut size={18} strokeWidth={1.8} aria-hidden="true" />
					</button>
				{/if}
				{#if hasOpenSession}
					<button class="icon-button navigator-close" onclick={onClose} aria-label="Close workspace navigator" title="Close workspaces">
						<X size={19} strokeWidth={1.8} aria-hidden="true" />
					</button>
				{/if}
			</div>
		</header>

		<div class="session-order-toolbar">
			<div class="session-order-control" role="group" aria-label="Workspace order">
				<button type="button" class:active={sessionOrderMode === 'recent'} onclick={() => onOrderModeChange('recent')} aria-pressed={sessionOrderMode === 'recent'}>Recent</button>
				<button type="button" class:active={sessionOrderMode === 'manual'} onclick={() => onOrderModeChange('manual')} aria-pressed={sessionOrderMode === 'manual'}>Manual</button>
			</div>
			<span class="session-order-help">{sessionOrderMode === 'recent' ? 'Latest output' : 'Drag to arrange'}</span>
		</div>

		{#if errorMessage}
			<p class="error panel-message" role="alert">{errorMessage}</p>
		{:else if sessions.length === 0}
			<div class="empty-state">
				<div class="empty-state__icon" aria-hidden="true"><SquareTerminal size={24} strokeWidth={1.7} /></div>
				<h2>No workspaces yet</h2>
				<p>Open a project shell. The workspace stays available until you remove it.</p>
				<button class="secondary-button" onclick={openNewSession}>New workspace</button>
			</div>
		{:else}
			<div class="sessions">
				{#each displayedSessions as session (session.id)}
					{@const hasUnreadOutput = unreadSessionIds.has(session.id)}
					{@const activityState = sessionActivityState(session, activeOutputSessionId, hasUnreadOutput)}
					{@const process = sessionProcess(session)}
					<div
						class="session-row-shell"
						class:active={activeSessionId === session.id}
						class:dragging={draggedSessionId === session.id}
						class:dropBefore={dragOverSessionId === session.id && dropPosition === 'before'}
						class:dropAfter={dragOverSessionId === session.id && dropPosition === 'after'}
						role="group"
						draggable={sessionOrderMode === 'manual'}
						ondragstart={(event) => beginSessionDrag(event, session.id)}
						ondragover={(event) => updateSessionDropTarget(event, session.id)}
						ondrop={(event) => dropSession(event, session.id)}
						ondragend={endSessionDrag}
						title={sessionOrderMode === 'manual' ? 'Drag to reorder, or use Alt + Up/Down' : undefined}
					>
						<button
							class="session-row"
							class:missing={session.state === 'missing'}
							onclick={() => onOpen(session)}
							oncontextmenu={(event) => handleSessionContextMenu(event, session)}
							onkeydown={(event) => handleSessionOrderKeydown(event, session.id)}
							aria-current={activeSessionId === session.id ? 'true' : undefined}
							aria-label={`Open ${session.state === 'missing' ? 'ended' : 'running'} ${projectName(session.cwd)} workspace (${process.label}; ${sessionActivityHint(session, activeOutputSessionId, hasUnreadOutput)}${session.note ? '; has a note' : ''})`}
						>
							<span class="row-leading" aria-hidden="true">
								{#if sessionOrderMode === 'manual'}<span class="drag-handle"><GripVertical size={14} strokeWidth={1.8} /></span>{/if}
								<span
									class="status-dot"
									class:live={activityState === 'live'}
									class:review={activityState === 'review'}
									class:missing={activityState === 'missing'}
									title={sessionActivityHint(session, activeOutputSessionId, hasUnreadOutput)}
								></span>
							</span>
							<span class="session-summary">
								<span class="session-title">
									<strong>{projectName(session.cwd)}</strong>
									{#if session.note}<span class="session-note-indicator" title={session.note} aria-hidden="true"><StickyNote size={12} strokeWidth={1.8} /></span>{/if}
								</span>
								<span class="session-context">
									<span class="session-program" style={`--session-program-color: ${sessionProcessColor(process.label)}`} title={sessionProcessHint(session)}>{process.label}</span>
									<span class="session-context-divider" aria-hidden="true">·</span>
									<time datetime={new Date(latestSessionOutputAt(session)).toISOString()} title={`Last terminal update ${new Date(latestSessionOutputAt(session)).toLocaleString()}`}>{formatSessionTimestamp(latestSessionOutputAt(session))}</time>
									{#if activityState === 'review'}
										<span class="review-hint" title="New terminal output needs review" aria-hidden="true">Review</span>
									{/if}
								</span>
							</span>
						</button>
						<button class="session-actions-trigger" type="button" onclick={(event) => onOpenActions(session, event.currentTarget)} aria-label={`Workspace actions for ${projectName(session.cwd)}`} title="Workspace actions">
							<Ellipsis size={18} strokeWidth={1.9} aria-hidden="true" />
						</button>
					</div>
				{/each}
			</div>
		{/if}
	</section>

	<section class="new-session-panel" class:expanded={newSessionOpen} aria-labelledby="new-workspace-title">
		<button class="new-session-toggle" type="button" onclick={() => newSessionOpen ? newSessionOpen = false : openNewSession()} aria-expanded={newSessionOpen} aria-controls="new-workspace-form">
			<span class="new-session-toggle__icon" aria-hidden="true"><Plus size={18} strokeWidth={2.3} /></span>
			<span><strong id="new-workspace-title">New workspace</strong><small>Open a shell in a project</small></span>
			<span class="new-session-chevron" class:open={newSessionOpen} aria-hidden="true"><ChevronDown size={18} strokeWidth={1.8} /></span>
		</button>

		{#if newSessionOpen}
			<form id="new-workspace-form" onsubmit={(event) => { event.preventDefault(); onCreate(); }}>
				<label for="cwd">Project path</label>
				<p id="cwd-help" class="field-help">Use the full directory path on this computer.</p>
				<input id="cwd" type="text" bind:this={cwdInput} bind:value={cwd} placeholder="/Users/you/project" autocapitalize="off" autocomplete="off" spellcheck="false" aria-describedby="cwd-help" required />
				{#if startError}<p class="error" role="alert">{startError}</p>{/if}
				<p class="ownership-note">The session keeps running in tmux if Vampire restarts.</p>
				<div class="new-session-actions">
					<button class="primary-button" disabled={starting || tmuxAvailable === false}>{starting ? 'Opening…' : 'Open shell'}</button>
				</div>
			</form>
		{/if}
	</section>
</div>

<style>
	.session-column { display: grid; grid-template-columns: minmax(0, 1fr) 20rem; align-items: start; gap: 1.25rem; min-width: 0; }
	.session-panel, .new-session-panel { border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-surface); }
	.session-panel { min-width: 0; overflow: hidden; }
	.section-header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; min-height: 4rem; padding: 0.8rem 1.35rem; }
	.section-header h1 { margin: 0; font-size: var(--text-title); font-weight: var(--weight-strong); line-height: var(--leading-tight); }
	.session-panel-title { display: flex; align-items: center; gap: 0.55rem; min-width: 0; }
	.section-actions { display: flex; align-items: center; gap: 0.5rem; }
	.session-count { display: grid; place-items: center; min-width: 1.7rem; height: 1.7rem; border-radius: 999px; background: var(--color-surface-raised); color: var(--color-text-secondary); font-size: var(--text-caption); font-weight: var(--weight-medium); }
	.session-order-toolbar { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 0.55rem; padding: 0.15rem 1.35rem 0.75rem; color: var(--color-text-tertiary); font-size: var(--text-caption); }
	.session-order-control { display: inline-flex; overflow: hidden; border: 1px solid var(--color-border); border-radius: 0.42rem; background: var(--color-surface-sunken); }
	.session-order-control button { min-height: 1.8rem; padding: 0 0.55rem; border: 0; border-right: 1px solid var(--color-border); background: transparent; color: var(--color-text-tertiary); font: inherit; font-weight: var(--weight-medium); cursor: pointer; }
	.session-order-control button:last-child { border-right: 0; }
	.session-order-control button:hover { color: var(--color-text); }
	.session-order-control button.active { background: var(--color-surface-selected); color: var(--color-text); }
	.session-order-help { overflow: hidden; text-align: right; text-overflow: ellipsis; white-space: nowrap; }
	.icon-button { display: grid; place-items: center; width: 2.6rem; height: 2.6rem; padding: 0; border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--color-text-secondary); cursor: pointer; }
	.icon-button:hover { background: var(--color-surface-raised); color: var(--color-text); }
	.icon-button:disabled { cursor: wait; opacity: 0.55; }
	.icon-button.spinning :global(svg) { animation: spin 0.8s linear infinite; }
	.navigator-close { display: none; }
	.sessions { border-top: 1px solid var(--color-border); }
	.session-row-shell { position: relative; min-width: 0; border-bottom: 1px solid var(--color-border); }
	.session-row-shell:last-child { border-bottom: 0; }
	.session-row { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 0.75rem; width: 100%; min-width: 0; min-height: 4.5rem; padding: 0.85rem 3.8rem 0.85rem 1.35rem; border: 0; background: transparent; color: inherit; text-align: left; cursor: pointer; }
	.session-row:hover { background: var(--color-surface-raised); }
	.session-row-shell.active { background: var(--color-surface-active); box-shadow: inset 0.18rem 0 var(--color-accent); }
	.session-row-shell[draggable="true"] { cursor: grab; }
	.session-row-shell.dragging { opacity: 0.42; cursor: grabbing; }
	.session-row-shell.dropBefore::before, .session-row-shell.dropAfter::after { position: absolute; z-index: 4; right: 0.65rem; left: 0.65rem; height: 2px; border-radius: 2px; background: var(--color-accent); content: ""; }
	.session-row-shell.dropBefore::before { top: 0; }
	.session-row-shell.dropAfter::after { bottom: -1px; }
	.session-actions-trigger { position: absolute; z-index: 3; top: 50%; right: 0.65rem; display: grid; place-items: center; width: 2.45rem; height: 2.45rem; padding: 0; transform: translateY(-50%); border: 0; border-radius: 0.5rem; background: transparent; color: var(--color-text-tertiary); cursor: pointer; }
	.session-actions-trigger:hover, .session-actions-trigger:focus-visible { background: var(--color-surface-raised); color: var(--color-text); }
	.row-leading { display: inline-flex; align-items: center; gap: 0.3rem; }
	.drag-handle { display: grid; place-items: center; color: var(--color-text-tertiary); line-height: 1; }
	.status-dot { width: 0.58rem; height: 0.58rem; border-radius: 50%; background: var(--color-success); box-shadow: var(--shadow-status-idle); }
	.status-dot.live { background: var(--color-warning); box-shadow: var(--shadow-status-live); animation: activity-pulse 1.4s ease-out infinite; }
	.status-dot.review { background: var(--color-info); box-shadow: var(--shadow-status-review); }
	.status-dot.missing { background: var(--color-status-missing); box-shadow: none; }
	.session-summary { display: grid; min-width: 0; gap: 0.28rem; }
	.session-title { display: flex; align-items: center; gap: 0.4rem; min-width: 0; }
	.session-title strong { overflow: hidden; font-size: var(--text-body); font-weight: var(--weight-medium); line-height: var(--leading-tight); text-overflow: ellipsis; white-space: nowrap; }
	.session-note-indicator { display: grid; flex: 0 0 auto; place-items: center; color: var(--color-note); }
	.session-context { display: flex; align-items: center; gap: 0.35rem; min-width: 0; overflow: hidden; color: var(--color-text-tertiary); font-size: var(--text-caption); line-height: var(--leading-ui); white-space: nowrap; }
	.session-program { flex: 0 0 auto; color: var(--session-program-color, var(--color-text-secondary)); font-weight: var(--weight-medium); }
	.session-context-divider { color: var(--color-text-disabled); }
	.session-context time { flex: 0 0 auto; color: var(--color-text-tertiary); font-variant-numeric: tabular-nums; }
	.review-hint { flex: 0 0 auto; padding: 0.08rem 0.34rem; border: 1px solid var(--color-info-border); border-radius: 999px; background: var(--color-info-surface); color: var(--color-info-text); font-size: 0.64rem; font-weight: var(--weight-medium); letter-spacing: 0.02em; line-height: 1.25; }
	.empty-state { display: grid; justify-items: start; padding: clamp(1.5rem, 6vw, 3rem) 1.35rem 2rem; border-top: 1px solid var(--color-border); }
	.empty-state__icon { margin-bottom: 1.1rem; color: var(--color-accent); }
	.empty-state h2 { margin: 0; font-size: var(--text-heading); font-weight: var(--weight-strong); line-height: var(--leading-tight); }
	.empty-state p { max-width: 28rem; margin: 0.45rem 0 1.2rem; color: var(--color-text-secondary); font-size: var(--text-body); line-height: var(--leading-body); }
	.new-session-panel { overflow: hidden; }
	.new-session-toggle { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 0.8rem; width: 100%; min-height: 4.6rem; padding: 0.9rem 1rem; border: 0; background: transparent; color: inherit; text-align: left; cursor: pointer; }
	.new-session-toggle:hover { background: var(--color-surface-raised); }
	.new-session-toggle__icon { display: grid; place-items: center; width: 2rem; height: 2rem; border-radius: 50%; background: var(--color-accent); color: var(--color-accent-ink); }
	.new-session-toggle strong, .new-session-toggle small { display: block; }
	.new-session-toggle strong { font-size: var(--text-body); font-weight: var(--weight-medium); }
	.new-session-toggle small { margin-top: 0.2rem; color: var(--color-text-secondary); font-size: var(--text-caption); }
	.new-session-chevron { display: grid; place-items: center; color: var(--color-text-tertiary); transition: transform 160ms ease; }
	.new-session-chevron.open { transform: rotate(180deg); }
	form { display: grid; gap: 0.7rem; padding: 0 1rem 1rem; border-top: 1px solid var(--color-border); }
	form label { margin-top: 1rem; color: var(--color-text); font-size: var(--text-label); font-weight: var(--weight-medium); }
	.field-help { margin: -0.35rem 0 0; color: var(--color-text-secondary); font-size: var(--text-caption); line-height: var(--leading-ui); }
	input { width: 100%; min-width: 0; min-height: 2.9rem; padding: 0 0.8rem; border: 1px solid var(--color-border-strong); border-radius: var(--radius-sm); background: var(--color-field-background); color: var(--color-text); font-size: var(--text-body); }
	input::placeholder { color: var(--color-field-placeholder); }
	.primary-button, .secondary-button { min-height: 2.5rem; padding: 0 0.9rem; border: 0; border-radius: var(--radius-sm); font-size: var(--text-label); font-weight: var(--weight-medium); cursor: pointer; }
	.primary-button { background: var(--color-accent); color: var(--color-accent-ink); }
	.primary-button:hover { background: var(--color-accent-hover); }
	.primary-button:disabled { cursor: wait; opacity: 0.65; }
	.secondary-button { background: var(--color-surface-raised); color: var(--color-text); }
	.new-session-actions { display: flex; justify-content: flex-end; }
	.ownership-note { margin: 0.2rem 0 0; color: var(--color-text-tertiary); font-size: var(--text-caption); line-height: var(--leading-ui); }
	.error { margin: 0; color: var(--color-danger); font-size: var(--text-label); line-height: var(--leading-ui); }
	.panel-message { margin: 0 1.35rem 1.35rem; }

	@keyframes spin { to { transform: rotate(360deg); } }
	@keyframes activity-pulse { 0%, 45% { box-shadow: var(--shadow-status-live-pulse); } 100% { box-shadow: var(--shadow-status-live-clear); } }

	@media (min-width: 64rem) {
		.session-column { display: flex; flex-direction: column; gap: 0; min-width: 0; height: 100%; overflow: hidden; border-right: 1px solid var(--color-border); background: var(--color-panel); }
		.session-panel, .new-session-panel { width: 100%; border: 0; border-radius: 0; background: transparent; }
		.session-panel { display: flex; flex: 1 1 auto; flex-direction: column; min-height: 0; }
		.sessions, .empty-state { min-height: 0; overflow-y: auto; }
		.sessions { flex: 1 1 0; }
		.new-session-panel { position: relative; z-index: 1; flex: 0 0 auto; max-height: 60%; overflow-y: auto; border-top: 1px solid var(--color-border); background: var(--color-panel); }
		.section-header { padding: 1rem; }
		.session-order-toolbar { padding-inline: 1rem; }
		.session-row { padding-inline: 1rem; padding-right: 3.55rem; }
	}

	@media (max-width: 63.999rem) {
		.session-column { position: fixed; z-index: 40; inset: 0 auto 0 0; display: flex; flex-direction: column; align-items: stretch; gap: 0; width: min(23rem, calc(100% - 2.5rem)); height: 100dvh; padding: env(safe-area-inset-top) 0 env(safe-area-inset-bottom); overflow-y: auto; transform: translateX(-100%); border-right: 1px solid var(--color-border-strong); background: var(--color-panel); box-shadow: var(--shadow-navigation-panel); pointer-events: none; transition: transform 180ms ease, visibility 0s linear 180ms; visibility: hidden; }
		.session-column.mobile-open { transform: translateX(0); pointer-events: auto; transition: transform 180ms ease; visibility: visible; }
		.session-panel, .new-session-panel { width: 100%; border: 0; border-radius: 0; background: transparent; }
		.session-panel { display: flex; flex: 1 1 auto; flex-direction: column; min-height: 0; }
		.sessions, .empty-state { min-height: 0; overflow-y: auto; }
		.sessions { flex: 1 1 0; }
		.new-session-panel { position: relative; z-index: 1; flex: 0 0 auto; max-height: 60%; overflow-y: auto; border-top: 1px solid var(--color-border); background: var(--color-panel); }
		.section-header { padding: 1rem; }
		.session-order-toolbar { padding-inline: 1rem; }
		.session-row { padding-inline: 1rem; padding-right: 3.55rem; }
		.navigator-close { display: grid; }
	}

	@media (max-width: 46rem) {
		.section-header { padding-inline: 1rem; }
		.session-row { padding-left: 1rem; }
	}

	@media (max-width: 32rem) {
		input { font-size: 1rem; }
	}

	@media (prefers-reduced-motion: reduce) {
		.new-session-chevron, .session-column { transition: none; }
		.status-dot.live { animation: none; }
		.icon-button.spinning :global(svg) { animation-duration: 1.6s; }
	}
</style>
