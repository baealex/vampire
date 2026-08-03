<script lang="ts">
	import { Popover } from 'bits-ui';
	import Network from '@lucide/svelte/icons/network';
	import PanelLeft from '@lucide/svelte/icons/panel-left';
	import PanelRight from '@lucide/svelte/icons/panel-right';
	import MemoryStick from '@lucide/svelte/icons/memory-stick';
	import Microchip from '@lucide/svelte/icons/microchip';
	import StickyNote from '@lucide/svelte/icons/sticky-note';
	import type { Snippet } from 'svelte';
	import ListeningPortsDialog from '$lib/system/ListeningPortsDialog.svelte';
	import { SYSTEM_METRICS_INTERVAL_MS, type SystemMetrics } from '$lib/system-metrics';
	import TerminalDisplayMenu from './TerminalDisplayMenu.svelte';

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
		isGitRepository,
		changeCount,
		worktreeCount,
		toggleRepository,
		toggleNote,
		noteEditor,
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
		isGitRepository?: boolean;
		changeCount: number;
		worktreeCount: number;
		toggleRepository: () => void;
		toggleNote: () => void;
		noteEditor?: Snippet;
		decreaseFontSize: () => void;
		increaseFontSize: () => void;
	} = $props();

	let listeningPortsOpen = $state(false);

	function formatMemory(bytes: number): string {
		const gigabytes = bytes / 1024 ** 3;
		return `${gigabytes >= 10 ? Math.round(gigabytes) : gigabytes.toFixed(1)} GB`;
	}

	function handleNoteOpenChange(nextOpen: boolean) {
		if (nextOpen !== noteOpen) toggleNote();
	}

	function cpuSampleTitle(metrics: SystemMetrics): string {
		const seconds = SYSTEM_METRICS_INTERVAL_MS / 1_000;
		return `CPU approximately ${metrics.cpuUsage}% — sampled average across all logical cores; refreshes about every ${seconds} seconds`;
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
			{#if isGitRepository && worktreeCount > 1}
				<span class="worktree-count" title="Git worktrees in this repository">{worktreeCount > 99 ? '99+' : worktreeCount} worktrees</span>
			{/if}
			<Popover.Root open={noteOpen} onOpenChange={handleNoteOpenChange}>
				<Popover.Trigger
					type="button"
					class={`note-button${hasNote ? ' has-note' : ''}${noteOpen ? ' active' : ''}`}
					aria-label={hasNote ? 'Open workspace note' : 'Add workspace note'}
					aria-expanded={noteOpen}
					title={hasNote ? 'Workspace note' : 'Add a workspace note'}
				>
					<StickyNote size={16} strokeWidth={1.8} aria-hidden="true" />
				</Popover.Trigger>
				<Popover.Portal>
					{#if noteOpen && noteEditor}
						<Popover.Content class="workspace-note-popover" side="bottom" align="start" sideOffset={8}>
							{@render noteEditor()}
						</Popover.Content>
					{/if}
				</Popover.Portal>
			</Popover.Root>
		</div>
		<span title={cwd}>{cwd}</span>
	</div>
	<div class="terminal-controls">
		{#if systemMetrics}
			<div
				class="system-metrics"
				role="group"
				aria-label={`Server resources: CPU approximately ${systemMetrics.cpuUsage} percent; RAM ${systemMetrics.memoryUsage} percent, ${formatMemory(systemMetrics.memoryUsedBytes)} of ${formatMemory(systemMetrics.memoryTotalBytes)} used.`}
			>
				<span class="system-metric" title={cpuSampleTitle(systemMetrics)}>
					<Microchip size={14} strokeWidth={1.8} aria-hidden="true" />
					<b>CPU</b>
					<output aria-label={`CPU approximately ${systemMetrics.cpuUsage} percent, sampled across all logical cores`}>≈{systemMetrics.cpuUsage}%</output>
				</span>
				<span class="system-metric" title={`RAM ${formatMemory(systemMetrics.memoryUsedBytes)} of ${formatMemory(systemMetrics.memoryTotalBytes)} (${systemMetrics.memoryUsage}%)`}>
					<MemoryStick size={14} strokeWidth={1.8} aria-hidden="true" />
					<b>RAM</b>
					<output>{systemMetrics.memoryUsage}%</output>
				</span>
			</div>
		{/if}
		<div class="terminal-tools" role="group" aria-label="Terminal tools">
			<button
				type="button"
				class="listening-ports-button"
				class:active={listeningPortsOpen}
				onclick={() => listeningPortsOpen = true}
				aria-label="Inspect listening ports"
				aria-expanded={listeningPortsOpen}
				title="Listening ports"
			>
				<Network size={16} strokeWidth={1.8} aria-hidden="true" />
				<span>Ports</span>
			</button>
			<TerminalDisplayMenu
				{fontSize}
				{minimumFontSize}
				{maximumFontSize}
				{decreaseFontSize}
				{increaseFontSize}
			/>
			{#if !repositoryOpen}
				<button
					type="button"
					class="repository-button"
					onclick={toggleRepository}
					aria-label={isGitRepository === false ? 'Open workspace files' : 'Open repository'}
					aria-expanded={repositoryOpen}
					title={isGitRepository === false ? 'Files' : 'Repository'}
				>
					<PanelRight size={16} strokeWidth={1.8} aria-hidden="true" />
					{#if isGitRepository && changeCount > 0}<span aria-label={`${changeCount} changed files`}>{changeCount > 99 ? '99+' : changeCount}</span>{/if}
				</button>
			{/if}
		</div>
	</div>
</header>

{#if listeningPortsOpen}
	<ListeningPortsDialog close={() => listeningPortsOpen = false} />
{/if}

<style>
	.terminal-header { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 0.75rem; min-width: 0; padding: max(0.65rem, env(safe-area-inset-top)) max(0.75rem, env(safe-area-inset-right)) 0.65rem max(0.75rem, env(safe-area-inset-left)); background: var(--color-panel); }
	.back-button { display: inline-flex; align-items: center; gap: 0.25rem; min-height: 2.65rem; padding: 0 0.65rem 0 0.45rem; border: 1px solid var(--color-border); border-radius: 0.55rem; background: var(--color-control-background); color: var(--color-text); font: inherit; font-weight: var(--weight-medium); cursor: pointer; }
	.back-button:hover { background: var(--color-surface-hover); }
	.terminal-identity { display: grid; min-width: 0; justify-items: center; gap: 0.18rem; }
	.terminal-identity-title { display: flex; align-items: center; gap: 0.45rem; min-width: 0; max-width: 100%; }
	.terminal-identity-title strong { min-width: 0; overflow: hidden; font-size: var(--text-body); font-weight: var(--weight-medium); line-height: var(--leading-tight); text-overflow: ellipsis; white-space: nowrap; }
	.terminal-identity > span { max-width: 100%; overflow: hidden; color: var(--color-text-tertiary); font-family: var(--font-mono); font-size: var(--text-caption); line-height: var(--leading-tight); text-overflow: ellipsis; white-space: nowrap; }
	.worktree-count { flex: 0 0 auto; padding: 0.08rem 0.3rem; border: 1px solid var(--color-border); border-radius: var(--radius-pill); color: var(--color-text-tertiary); font-size: var(--text-nano); font-variant-numeric: tabular-nums; line-height: 1.25; }
	.terminal-controls { display: flex; align-items: center; justify-content: flex-end; gap: 0.5rem; min-width: max-content; }
	.system-metrics { display: inline-flex; align-items: center; min-height: 1.9rem; overflow: hidden; border: 1px solid var(--color-border); border-radius: 0.42rem; background: var(--color-surface-overlay); color: var(--color-text-secondary); font-size: var(--text-caption); font-variant-numeric: tabular-nums; }
	.system-metric { display: inline-flex; align-items: center; gap: 0.28rem; min-height: 1.9rem; padding: 0 0.42rem; white-space: nowrap; }
	.system-metric + .system-metric { border-left: 1px solid var(--color-border); }
	.system-metric :global(svg) { color: var(--color-text-tertiary); }
	.system-metric b { font-weight: var(--weight-medium); }
	.system-metric output { color: var(--color-text); font: inherit; }
	.terminal-tools { display: flex; align-items: center; gap: 0.15rem; }
	:global(.note-button), .listening-ports-button, .repository-button { position: relative; display: grid; place-items: center; min-width: 2.35rem; height: 2.35rem; padding: 0; border: 1px solid transparent; border-radius: var(--radius-control); background: transparent; color: var(--color-text-tertiary); font: inherit; cursor: pointer; }
	:global(.note-button), .repository-button { width: 2.35rem; }
	.listening-ports-button { grid-auto-flow: column; gap: 0.38rem; padding-inline: 0.55rem; font-size: var(--text-caption); font-weight: var(--weight-medium); }
	:global(.note-button:hover), :global(.note-button.active), .listening-ports-button:hover, .listening-ports-button.active, .repository-button:hover { border-color: var(--color-border); background: var(--color-surface-selected); color: var(--color-text); }
	:global(.note-button.has-note) { color: var(--color-command); }
	:global(.note-button.has-note::after) { position: absolute; top: 0.38rem; right: 0.38rem; width: 0.32rem; height: 0.32rem; border-radius: 50%; background: var(--color-accent); content: ""; }
	.repository-button span { position: absolute; top: -0.25rem; right: -0.35rem; display: grid; place-items: center; min-width: 1.15rem; height: 1.15rem; padding: 0 0.24rem; border: 2px solid var(--color-panel); border-radius: var(--radius-pill); background: var(--color-accent); color: var(--color-accent-ink); font-size: var(--text-nano); font-weight: var(--weight-strong); font-variant-numeric: tabular-nums; }
	:global(.workspace-note-popover) { z-index: 60; width: min(30rem, calc(100vw - 1rem)); max-width: calc(100vw - 1rem); outline: none; }

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
		:global(.terminal-display-menu) { display: none; }
	}

	@media (max-width: 32rem) {
		.terminal-header { grid-template-columns: 2.65rem minmax(0, 1fr) auto; }
		.terminal-controls { gap: 0.35rem; }
		.system-metric b { display: none; }
		.listening-ports-button { width: 2.35rem; padding: 0; }
		.listening-ports-button span { display: none; }
	}
</style>
