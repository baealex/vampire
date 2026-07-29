<script lang="ts">
	import PanelLeft from '@lucide/svelte/icons/panel-left';
	import PanelRight from '@lucide/svelte/icons/panel-right';
	import Minus from '@lucide/svelte/icons/minus';
	import MemoryStick from '@lucide/svelte/icons/memory-stick';
	import Microchip from '@lucide/svelte/icons/microchip';
	import Plus from '@lucide/svelte/icons/plus';
	import StickyNote from '@lucide/svelte/icons/sticky-note';
	import type { SystemMetrics } from '$lib/system-metrics';

	let {
		projectName,
		cwd,
		hasNote,
		noteOpen,
		fontSize,
		minimumFontSize,
		maximumFontSize,
		systemMetrics,
		close,
		repositoryOpen,
		changeCount,
		worktreeCount,
		toggleRepository,
		toggleNote,
		decreaseFontSize,
		increaseFontSize
	}: {
		projectName: string;
		cwd: string;
		hasNote: boolean;
		noteOpen: boolean;
		fontSize: number;
		minimumFontSize: number;
		maximumFontSize: number;
		systemMetrics?: SystemMetrics;
		close: () => void;
		repositoryOpen: boolean;
		changeCount: number;
		worktreeCount: number;
		toggleRepository: () => void;
		toggleNote: () => void;
		decreaseFontSize: () => void;
		increaseFontSize: () => void;
	} = $props();

	function formatMemory(bytes: number): string {
		const gigabytes = bytes / 1024 ** 3;
		return `${gigabytes >= 10 ? Math.round(gigabytes) : gigabytes.toFixed(1)} GB`;
	}
</script>

<header class="terminal-header">
	<button class="back-button" onclick={close} aria-label="Open workspaces">
		<PanelLeft size={18} strokeWidth={1.8} aria-hidden="true" />
		<span>Workspaces</span>
	</button>
	<div class="terminal-identity">
		<div class="terminal-identity-title">
			<strong>{projectName}</strong>
			{#if worktreeCount > 1}
				<span class="worktree-count" title="Git worktrees in this repository">{worktreeCount > 99 ? '99+' : worktreeCount} worktrees</span>
			{/if}
		</div>
		<span title={cwd}>{cwd}</span>
	</div>
	<div class="terminal-controls">
		{#if systemMetrics}
			<div
				class="system-metrics"
				role="group"
				aria-label={`Server resources: CPU ${systemMetrics.cpuUsage} percent; RAM ${systemMetrics.memoryUsage} percent, ${formatMemory(systemMetrics.memoryUsedBytes)} of ${formatMemory(systemMetrics.memoryTotalBytes)} used.`}
			>
				<span class="system-metric" title={`CPU ${systemMetrics.cpuUsage}%`}>
					<Microchip size={14} strokeWidth={1.8} aria-hidden="true" />
					<b>CPU</b>
					<output>{systemMetrics.cpuUsage}%</output>
				</span>
				<span class="system-metric" title={`RAM ${formatMemory(systemMetrics.memoryUsedBytes)} of ${formatMemory(systemMetrics.memoryTotalBytes)} (${systemMetrics.memoryUsage}%)`}>
					<MemoryStick size={14} strokeWidth={1.8} aria-hidden="true" />
					<b>RAM</b>
					<output>{systemMetrics.memoryUsage}%</output>
				</span>
			</div>
		{/if}
		<button
			type="button"
			class="repository-button"
			class:active={repositoryOpen}
			onclick={toggleRepository}
			aria-label={repositoryOpen ? 'Close repository' : 'Open repository'}
			aria-expanded={repositoryOpen}
			title="Repository"
		>
			<PanelRight size={16} strokeWidth={1.8} aria-hidden="true" />
			{#if changeCount > 0}<span aria-label={`${changeCount} changed files`}>{changeCount > 99 ? '99+' : changeCount}</span>{/if}
		</button>
		<button
			type="button"
			class="note-button"
			class:has-note={hasNote}
			class:active={noteOpen}
			onclick={toggleNote}
			aria-label={hasNote ? 'Open workspace note' : 'Add workspace note'}
			aria-expanded={noteOpen}
			title={hasNote ? 'Workspace note' : 'Add a workspace note'}
		>
			<StickyNote size={16} strokeWidth={1.8} aria-hidden="true" />
		</button>
		<div class="font-size-control" role="group" aria-label="Terminal text size">
			<button
				type="button"
				onclick={decreaseFontSize}
				disabled={fontSize <= minimumFontSize}
				aria-label="Decrease terminal text size"
				title="Decrease text size"
			><Minus size={14} strokeWidth={2} aria-hidden="true" /></button>
			<output aria-label={`Terminal text size ${fontSize} pixels`}>{fontSize}</output>
			<button
				type="button"
				onclick={increaseFontSize}
				disabled={fontSize >= maximumFontSize}
				aria-label="Increase terminal text size"
				title="Increase text size"
			><Plus size={14} strokeWidth={2} aria-hidden="true" /></button>
		</div>
	</div>
</header>

<style>
	.terminal-header { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 0.75rem; min-width: 0; padding: max(0.65rem, env(safe-area-inset-top)) max(0.75rem, env(safe-area-inset-right)) 0.65rem max(0.75rem, env(safe-area-inset-left)); border-bottom: 1px solid var(--color-border-subtle); background: var(--color-panel); }
	.back-button { display: inline-flex; align-items: center; gap: 0.25rem; min-height: 2.65rem; padding: 0 0.65rem 0 0.45rem; border: 1px solid var(--color-border); border-radius: 0.55rem; background: var(--color-control-background); color: var(--color-text); font: inherit; font-weight: var(--weight-medium); cursor: pointer; }
	.back-button:hover { background: var(--color-surface-hover); }
	.terminal-identity { display: grid; min-width: 0; justify-items: center; gap: 0.18rem; }
	.terminal-identity-title { display: flex; align-items: center; gap: 0.45rem; min-width: 0; max-width: 100%; }
	.terminal-identity-title strong { min-width: 0; overflow: hidden; font-size: var(--text-body); font-weight: var(--weight-medium); line-height: var(--leading-tight); text-overflow: ellipsis; white-space: nowrap; }
	.terminal-identity > span { max-width: 100%; overflow: hidden; color: var(--color-text-tertiary); font-family: ui-monospace, monospace; font-size: var(--text-caption); line-height: var(--leading-tight); text-overflow: ellipsis; white-space: nowrap; }
	.worktree-count { flex: 0 0 auto; padding: 0.08rem 0.3rem; border: 1px solid var(--color-border); border-radius: 999px; color: var(--color-text-tertiary); font-size: 0.64rem; font-variant-numeric: tabular-nums; line-height: 1.25; }
	.terminal-controls { display: flex; align-items: center; justify-content: flex-end; gap: 0.45rem; min-width: max-content; }
	.system-metrics { display: inline-flex; align-items: center; min-height: 1.9rem; overflow: hidden; border: 1px solid var(--color-border); border-radius: 0.42rem; background: var(--color-surface-overlay); color: var(--color-text-secondary); font-size: var(--text-caption); font-variant-numeric: tabular-nums; }
	.system-metric { display: inline-flex; align-items: center; gap: 0.28rem; min-height: 1.9rem; padding: 0 0.42rem; white-space: nowrap; }
	.system-metric + .system-metric { border-left: 1px solid var(--color-border); }
	.system-metric :global(svg) { color: var(--color-text-tertiary); }
	.system-metric b { font-weight: var(--weight-medium); }
	.system-metric output { color: var(--color-text); font: inherit; }
	.note-button, .repository-button { position: relative; display: grid; place-items: center; width: 2.35rem; height: 2.35rem; padding: 0; border: 1px solid transparent; border-radius: 0.5rem; background: transparent; color: var(--color-text-tertiary); cursor: pointer; }
	.note-button:hover, .note-button.active, .repository-button:hover, .repository-button.active { border-color: var(--color-border); background: var(--color-surface-selected); color: var(--color-text); }
	.note-button.has-note { color: var(--color-command); }
	.note-button.has-note::after { position: absolute; top: 0.38rem; right: 0.38rem; width: 0.32rem; height: 0.32rem; border-radius: 50%; background: var(--color-accent); content: ""; }
	.repository-button span { position: absolute; top: -0.25rem; right: -0.35rem; display: grid; place-items: center; min-width: 1.15rem; height: 1.15rem; padding: 0 0.24rem; border: 2px solid var(--color-panel); border-radius: 999px; background: var(--color-accent); color: var(--color-accent-ink); font-size: 0.62rem; font-weight: var(--weight-strong); font-variant-numeric: tabular-nums; }
	.font-size-control { display: inline-grid; grid-template-columns: 1.9rem 2.1rem 1.9rem; align-items: center; height: 1.9rem; overflow: hidden; border: 1px solid var(--color-border); border-radius: 0.42rem; background: var(--color-surface-overlay); }
	.font-size-control button { display: grid; place-items: center; width: 100%; height: 100%; padding: 0; border: 0; background: transparent; color: var(--color-text-secondary); font: inherit; cursor: pointer; }
	.font-size-control button:hover:not(:disabled) { background: var(--color-control-hover); color: var(--color-text); }
	.font-size-control button:disabled { color: var(--color-control-disabled); cursor: default; }
	.font-size-control output { display: grid; place-items: center; height: 100%; border-inline: 1px solid var(--color-border); color: var(--color-text-tertiary); font-family: ui-monospace, monospace; font-size: var(--text-caption); font-variant-numeric: tabular-nums; }

	@media (min-width: 64rem) {
		.terminal-header { grid-template-columns: minmax(0, 1fr) auto; }
		.back-button { display: none; }
		.terminal-identity { justify-items: start; }
	}

	@media (max-width: 63.999rem) {
		.terminal-header { gap: 0.5rem; }
		.back-button { width: 2.65rem; padding: 0; justify-content: center; }
		.back-button span, .terminal-identity > span { display: none; }
		.terminal-identity { justify-items: start; }
	}

	@media (max-width: 32rem) {
		.terminal-header { grid-template-columns: 2.65rem minmax(0, 1fr) auto; }
		.font-size-control, .system-metric b { display: none; }
	}
</style>
