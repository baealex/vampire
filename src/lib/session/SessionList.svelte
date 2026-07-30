<script lang="ts">
import ChevronRight from '@lucide/svelte/icons/chevron-right';
import SquareTerminal from '@lucide/svelte/icons/square-terminal';
	import StickyNote from '@lucide/svelte/icons/sticky-note';
	import SessionActionsMenu from './SessionActionsMenu.svelte';
	import type { ManagedSession, SessionOrderMode } from './types';
	import type { SessionActivityRecords, SessionActivityState } from './view';
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
		selectedSessionId,
		activityRecords,
		errorMessage,
		sessionOrderMode,
		onReorder,
		onOpen,
		sessionAction,
		onCloseSession,
		onRemoveSession,
		onNewSession
	}: {
		sessions: ManagedSession[];
		displayedSessions: ManagedSession[];
		selectedSessionId?: string;
		activityRecords: SessionActivityRecords;
		errorMessage: string;
		sessionOrderMode: SessionOrderMode;
		onReorder: (draggedId: string, targetId: string, position: 'before' | 'after') => void;
		onOpen: (session: ManagedSession) => void;
		sessionAction?: 'restart' | 'close' | 'remove';
		onCloseSession: (session: ManagedSession) => Promise<{ ok: boolean; error?: string }>;
		onRemoveSession: (session: ManagedSession) => Promise<{ ok: boolean; error?: string }>;
		onNewSession: () => void;
	} = $props();

	const SMART_ACTIVITY_GROUPS: { state: SessionActivityState; label: string }[] = [
		{ state: 'active', label: 'Working' },
		{ state: 'review', label: 'Review needed' },
		{ state: 'idle', label: 'Idle' },
		{ state: 'ended', label: 'Ended' }
	];

	let draggedSessionId = $state<string>();
	let dragOverSessionId = $state<string>();
	let dropPosition = $state<'before' | 'after'>('before');
	let openActionSessionId = $state<string>();
	let endedGroupExpanded = $state(false);
	const smartActivityGroups = $derived(SMART_ACTIVITY_GROUPS.map((group) => ({
		...group,
		sessions: displayedSessions.filter(
			(session) => sessionActivityState(session, activityRecords) === group.state
		)
	})));
	const selectedEndedSession = $derived(displayedSessions.some(
		(session) => session.id === selectedSessionId && sessionActivityState(session, activityRecords) === 'ended'
	));
	$effect(() => {
		if (selectedEndedSession) endedGroupExpanded = true;
	});

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
		openActionSessionId = session.id;
	}

	function handleSessionActionsOpen(sessionId: string, open: boolean) {
		if (open) openActionSessionId = sessionId;
		else if (openActionSessionId === sessionId) openActionSessionId = undefined;
	}
</script>

{#snippet sessionRows(groupSessions: ManagedSession[])}
	{#each groupSessions as session (session.id)}
		{@const activityState = sessionActivityState(session, activityRecords)}
		{@const process = sessionProcess(session)}
		<div
			class="session-row-shell"
			class:selected={selectedSessionId === session.id}
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
				aria-current={selectedSessionId === session.id ? 'true' : undefined}
				aria-label={`Open ${session.state === 'missing' ? 'ended' : 'running'} ${projectName(session.cwd)} workspace (${process?.label ? `${process.label}; ` : ''}${sessionActivityHint(session, activityRecords)}${session.notePreview ? '; has a note' : ''})`}
			>
				<span class="row-leading" aria-hidden="true">
					<span
						class="status-dot"
						class:output-active={activityState === 'active'}
						class:review={activityState === 'review'}
						class:ended={activityState === 'ended'}
						title={sessionActivityHint(session, activityRecords)}
					></span>
				</span>
				<span class="session-summary">
					<span class="session-title" title={projectName(session.cwd)}>
						<strong>{projectName(session.cwd)}</strong>
					</span>
					{#if session.notePreview}
						<span class="session-note-preview" title={session.notePreview}>
							<span class="session-note-indicator" aria-hidden="true"><StickyNote size={12} strokeWidth={1.8} /></span>
							<span class="session-note-text">{session.notePreview}</span>
						</span>
					{/if}
					<span class="session-context">
						{#if process}
							<span class="session-program" style={`--session-program-color: ${sessionProcessColor(process)}`} title={sessionProcessHint(session)}>{process.label}</span>
							<span class="session-context-divider" aria-hidden="true">·</span>
						{/if}
						<time datetime={new Date(latestSessionOutputAt(session)).toISOString()} title={`Last terminal update ${new Date(latestSessionOutputAt(session)).toLocaleString()}`}>{formatSessionTimestamp(latestSessionOutputAt(session))}</time>
					</span>
				</span>
			</button>
			<div class="session-actions-menu">
				<SessionActionsMenu
					session={session}
					open={openActionSessionId === session.id}
					onOpenChange={(open) => handleSessionActionsOpen(session.id, open)}
					action={sessionAction}
					closeSession={onCloseSession}
					remove={onRemoveSession}
				/>
			</div>
		</div>
	{/each}
{/snippet}

{#if errorMessage}
	<p class="error panel-message" role="alert">{errorMessage}</p>
{:else if sessions.length === 0}
	<div class="empty-state">
		<div class="empty-state__icon" aria-hidden="true"><SquareTerminal size={24} strokeWidth={1.7} /></div>
		<h2>No workspaces yet</h2>
		<p>Open a project shell. The workspace stays available until you remove it.</p>
		<button class="secondary-button" onclick={onNewSession}>New workspace</button>
	</div>
{:else}
	<div class="sessions">
		{#if sessionOrderMode === 'activity'}
			{#each smartActivityGroups as group (group.state)}
				{#if group.sessions.length > 0}
					<section
						class="session-group"
						class:working={group.state === 'active'}
						class:review={group.state === 'review'}
						class:idle={group.state === 'idle'}
						class:ended={group.state === 'ended'}
						aria-labelledby={`session-group-${group.state}`}
					>
						{#if group.state === 'ended'}
							<button
								class="session-group-header session-group-toggle"
								type="button"
								onclick={() => endedGroupExpanded = !endedGroupExpanded}
								aria-expanded={endedGroupExpanded}
								aria-controls="ended-session-group"
							>
								<span id="session-group-ended">{group.label}</span>
								<span class="session-group-count">{group.sessions.length}</span>
								<ChevronRight class={endedGroupExpanded ? 'expanded' : undefined} size={14} strokeWidth={1.8} aria-hidden="true" />
							</button>
							{#if endedGroupExpanded}
								<div id="ended-session-group">{@render sessionRows(group.sessions)}</div>
							{/if}
						{:else}
							<h2 class="session-group-header" id={`session-group-${group.state}`}>
								<span>{group.label}</span>
								<span class="session-group-count">{group.sessions.length}</span>
							</h2>
							{@render sessionRows(group.sessions)}
						{/if}
					</section>
				{/if}
			{/each}
		{:else}
			{@render sessionRows(displayedSessions)}
		{/if}
	</div>
{/if}

<style>
	.sessions { border-top: 1px solid var(--color-border); }
	.session-group + .session-group { border-top: 1px solid var(--color-border); }
	.session-group-header { display: flex; align-items: center; gap: 0.38rem; min-height: 2rem; margin: 0; padding: 0.45rem 1rem 0.38rem; border: 0; background: var(--color-panel); color: var(--color-text-tertiary); font: inherit; font-size: var(--text-nano); font-weight: var(--weight-medium); letter-spacing: 0.065em; line-height: var(--leading-ui); text-transform: uppercase; }
	.session-group.working .session-group-header { color: var(--color-warning-accent); }
	.session-group.review .session-group-header { color: var(--color-info-text); }
	.session-group.idle .session-group-header { color: var(--color-success-text); }
	.session-group-count { color: var(--color-text-disabled); font-variant-numeric: tabular-nums; letter-spacing: 0; }
	.session-group-toggle { width: 100%; text-align: left; cursor: pointer; }
	.session-group-toggle:hover { background: var(--color-surface-raised); color: var(--color-text-secondary); }
	.session-group-toggle :global(svg) { margin-left: auto; transition: transform 150ms ease; }
	.session-group-toggle :global(svg.expanded) { transform: rotate(90deg); }
	.session-row-shell { position: relative; min-width: 0; border-bottom: 1px solid var(--color-border); }
	.session-row-shell:last-child { border-bottom: 0; }
	.session-row { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 0.75rem; width: 100%; min-width: 0; min-height: 4.5rem; padding: 0.85rem 3.8rem 0.85rem 1.35rem; border: 0; background: transparent; color: inherit; text-align: left; cursor: pointer; }
	.session-row:hover { background: var(--color-surface-raised); }
	.session-row-shell.selected .session-row:hover { background: var(--color-surface-active-hover); }
	.session-row-shell.selected { background: var(--color-surface-active); box-shadow: inset 0.18rem 0 var(--color-accent); }
	.session-row-shell[draggable="true"] { cursor: grab; }
	.session-row-shell.dragging { opacity: 0.42; cursor: grabbing; }
	.session-row-shell.dropBefore::before, .session-row-shell.dropAfter::after { position: absolute; z-index: 4; right: 0.65rem; left: 0.65rem; height: 2px; border-radius: 2px; background: var(--color-accent); content: ""; }
	.session-row-shell.dropBefore::before { top: 0; }
	.session-row-shell.dropAfter::after { bottom: -1px; }
	.session-actions-menu { position: absolute; z-index: 3; top: 50%; right: 0.65rem; transform: translateY(-50%); }
	.row-leading { display: inline-flex; align-items: center; gap: 0.3rem; }
	.status-dot { box-sizing: border-box; width: 0.58rem; height: 0.58rem; border-radius: 50%; background: var(--color-success); box-shadow: none; }
	.status-dot.output-active { background: var(--color-warning); box-shadow: var(--shadow-status-active); animation: activity-pulse 1.4s ease-out infinite; }
	.status-dot.review { border: 0.12rem solid var(--color-info); background: transparent; box-shadow: var(--shadow-status-review); }
	.status-dot.ended { border: 0.1rem solid var(--color-status-missing); background: transparent; box-shadow: none; }
	.session-row.missing .session-summary { opacity: 0.62; }
	.session-summary { display: grid; min-width: 0; gap: 0.28rem; }
	.session-title { display: flex; align-items: center; gap: 0.4rem; min-width: 0; }
	.session-title strong { overflow: hidden; font-size: var(--text-body); font-weight: var(--weight-medium); line-height: var(--leading-tight); text-overflow: ellipsis; white-space: nowrap; }
	.session-note-preview { display: flex; align-items: center; gap: 0.3rem; min-width: 0; margin-inline: 0.15rem 0.35rem; padding: 0.3rem 0.45rem; border-radius: var(--radius-xs); background: var(--color-note-surface); color: var(--color-note); font-size: var(--text-caption); line-height: var(--leading-ui); white-space: nowrap; }
	.session-row-shell.selected .session-note-preview { background: transparent; }
	.session-note-indicator { display: grid; flex: 0 0 auto; place-items: center; }
	.session-note-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
	.session-context { display: flex; align-items: center; gap: 0.35rem; min-width: 0; overflow: hidden; color: var(--color-text-tertiary); font-size: var(--text-caption); line-height: var(--leading-ui); white-space: nowrap; }
	.session-program { flex: 0 0 auto; color: var(--session-program-color, var(--color-text-secondary)); font-weight: var(--weight-medium); }
	.session-context-divider { color: var(--color-text-disabled); }
	.session-context time { flex: 0 0 auto; color: var(--color-text-tertiary); font-variant-numeric: tabular-nums; }
	.empty-state { display: grid; justify-items: start; padding: clamp(1.5rem, 6vw, 3rem) 1.35rem 2rem; border-top: 1px solid var(--color-border); }
	.empty-state__icon { margin-bottom: 1.1rem; color: var(--color-accent); }
	.empty-state h2 { margin: 0; font-size: var(--text-heading); font-weight: var(--weight-strong); line-height: var(--leading-tight); }
	.empty-state p { max-width: 28rem; margin: 0.45rem 0 1.2rem; color: var(--color-text-secondary); font-size: var(--text-body); line-height: var(--leading-body); }
	.secondary-button { min-height: var(--control-height-md); padding: 0 0.9rem; border: 0; border-radius: var(--radius-sm); background: var(--color-surface-raised); color: var(--color-text); font-size: var(--text-label); font-weight: var(--weight-medium); cursor: pointer; }
	.secondary-button:hover:not(:disabled) { background: var(--color-surface-hover); }
	.secondary-button:disabled { cursor: wait; opacity: 0.62; }
	.error { margin: 0; color: var(--color-danger); font-size: var(--text-label); line-height: var(--leading-ui); }
	.panel-message { margin: 0 1.35rem 1.35rem; }

	@keyframes activity-pulse { 0%, 45% { box-shadow: var(--shadow-status-active-pulse); } 100% { box-shadow: var(--shadow-status-active-clear); } }

	@media (min-width: 64rem) {
		.sessions, .empty-state { min-height: 0; overflow-y: auto; }
		.sessions { flex: 1 1 0; }
		.session-row { padding-inline: 1rem; padding-right: 3.55rem; }
	}

	@media (max-width: 63.999rem) {
		.sessions, .empty-state { min-height: 0; overflow-y: auto; }
		.sessions { flex: 1 1 0; }
		.session-row { padding-inline: 1rem; padding-right: 3.55rem; }
	}

	@media (max-width: 46rem) {
		.session-row { padding-left: 1rem; }
	}

	@media (prefers-reduced-motion: reduce) {
		.status-dot.output-active { animation: none; }
		.session-group-toggle :global(svg) { transition: none; }
	}
</style>
