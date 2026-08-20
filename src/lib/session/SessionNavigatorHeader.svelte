<script lang="ts">
	import LogOut from '@lucide/svelte/icons/log-out';
	import X from '@lucide/svelte/icons/x';
	import ThemeToggle from '$lib/theme/ThemeToggle.svelte';
	import IconButton from '$lib/ui/IconButton.svelte';
	import type { SessionOrderMode } from './types';

	let {
		sessionCount,
		authenticationRequired,
		hasOpenSession,
		sessionOrderMode,
		workspacePreferencesError,
		onLogout,
		onClose,
		onOrderModeChange
	}: {
		sessionCount: number;
		authenticationRequired: boolean;
		hasOpenSession: boolean;
		sessionOrderMode: SessionOrderMode;
		workspacePreferencesError: string;
		onLogout: () => void;
		onClose: () => void;
		onOrderModeChange: (mode: SessionOrderMode) => void;
	} = $props();
</script>

<header class="section-header">
	<div class="session-panel-title">
		<h1 id="workspaces-title">Workspaces</h1>
		<span class="session-count" aria-label={`${sessionCount} workspaces`}>{sessionCount}</span>
	</div>
	<div class="section-actions">
		<ThemeToggle />
		{#if authenticationRequired}
			<IconButton label="Sign out" onclick={onLogout}>
				<LogOut size={18} strokeWidth={1.8} aria-hidden="true" />
			</IconButton>
		{/if}
		{#if hasOpenSession}
			<span class="navigator-close">
				<IconButton label="Close workspace navigator" title="Close workspaces" onclick={onClose}>
					<X size={19} strokeWidth={1.8} aria-hidden="true" />
				</IconButton>
			</span>
		{/if}
	</div>
</header>

<div class="session-order-toolbar">
	<div class="session-order-control" role="group" aria-label="Workspace order">
		<button
			type="button"
			class:active={sessionOrderMode === 'activity'}
			onclick={() => onOrderModeChange('activity')}
			aria-pressed={sessionOrderMode === 'activity'}
			aria-label="Group workspaces by status"
			title="Working and review-needed workspaces first"
		>
			Smart
		</button>
		<button
			type="button"
			class:active={sessionOrderMode === 'manual'}
			onclick={() => onOrderModeChange('manual')}
			aria-pressed={sessionOrderMode === 'manual'}
			aria-label="Arrange workspaces manually"
			title="Drag rows to reorder"
		>
			Manual
		</button>
	</div>
	<span class:error={Boolean(workspacePreferencesError)} class="session-order-help" role={workspacePreferencesError ? 'alert' : 'status'}>
		{workspacePreferencesError || (sessionOrderMode === 'activity' ? 'Main session status' : 'Drag rows to reorder')}
	</span>
</div>

<style>
	.section-header { display: flex; align-items: center; justify-content: space-between; gap: 0.65rem; min-height: 3.25rem; padding: 0.65rem 1rem; }
	.section-header h1 { min-width: 0; margin: 0; overflow: hidden; color: var(--color-text); font-size: var(--text-body); font-weight: var(--weight-medium); line-height: var(--leading-tight); text-overflow: ellipsis; white-space: nowrap; }
	.session-panel-title { display: flex; flex: 1 1 auto; align-items: center; gap: 0.45rem; min-width: 0; }
	.section-actions { display: flex; flex: 0 0 auto; align-items: center; gap: 0.25rem; }
	.session-count { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; min-width: 1.85rem; height: 1.4rem; padding: 0 0.42rem; border: 1px solid var(--color-border); border-radius: var(--radius-pill); background: transparent; color: var(--color-text-tertiary); font-size: var(--text-micro); font-weight: var(--weight-medium); font-variant-numeric: tabular-nums; }
	.session-order-toolbar { display: flex; align-items: center; gap: 0.45rem; min-width: 0; padding: 0 1rem 0.6rem; color: var(--color-text-tertiary); font-size: var(--text-caption); }
	.session-order-control { display: inline-flex; overflow: hidden; border: 1px solid var(--color-border); border-radius: 0.42rem; background: var(--color-surface-sunken); }
	.session-order-control button { min-height: 1.8rem; padding: 0 0.55rem; border: 0; border-right: 1px solid var(--color-border); background: transparent; color: var(--color-text-tertiary); font: inherit; font-weight: var(--weight-medium); cursor: pointer; }
	.session-order-control button:last-child { border-right: 0; }
	.session-order-control button:hover { color: var(--color-text); }
	.session-order-control button.active { background: var(--color-surface-selected); color: var(--color-text); }
	.session-order-help { min-width: 0; margin-left: auto; overflow: hidden; color: var(--color-text-tertiary); text-align: right; text-overflow: ellipsis; white-space: nowrap; }
	.session-order-help.error { color: var(--color-danger-text); }
	.navigator-close { display: none; }

	@media (max-width: 63.999rem) {
		.session-order-control button { min-height: 2.75rem; }
		.navigator-close { display: grid; }
	}

	@media (max-width: 24rem) {
		.section-header { align-items: flex-start; flex-wrap: wrap; min-height: 0; gap: 0.4rem 0.65rem; padding-block: 0.6rem; }
		.session-panel-title, .section-actions { flex-basis: 100%; }
		.section-actions { justify-content: flex-end; }
	}
</style>
