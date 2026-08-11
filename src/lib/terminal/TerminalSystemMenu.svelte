<script lang="ts">
	import { DropdownMenu } from 'bits-ui';
	import Gauge from '@lucide/svelte/icons/gauge';
	import MemoryStick from '@lucide/svelte/icons/memory-stick';
	import Microchip from '@lucide/svelte/icons/microchip';
	import Network from '@lucide/svelte/icons/network';
	import type { SystemMetrics } from '$lib/system-metrics';
	import DropdownMenuShell from '$lib/ui/DropdownMenuShell.svelte';

	let {
		systemMetrics,
		openListeningPorts
	}: {
		systemMetrics?: SystemMetrics;
		openListeningPorts: () => void;
	} = $props();

	function formatMemory(bytes: number): string {
		const gigabytes = bytes / 1024 ** 3;
		return `${gigabytes >= 10 ? Math.round(gigabytes) : gigabytes.toFixed(1)} GB`;
	}
</script>

<div class="terminal-system-menu">
	<DropdownMenuShell
		align="end"
		triggerClass="vampire-menu-trigger terminal-system-trigger"
		triggerLabel="Open server status"
		triggerTitle="Server status"
	>
		{#snippet trigger()}
			<Gauge size={17} strokeWidth={1.8} aria-hidden="true" />
		{/snippet}

		{#snippet children()}
			<div class="vampire-menu-heading" role="presentation">
				<strong>Server status</strong>
				<span>Resources and networking</span>
			</div>
			<div class="server-metrics" role="group" aria-label="Server resources">
				{#if systemMetrics}
					<div class="server-metric">
						<Microchip size={16} strokeWidth={1.8} aria-hidden="true" />
						<span>CPU</span>
						<output>≈{systemMetrics.cpuUsage}%</output>
					</div>
					<div class="server-metric">
						<MemoryStick size={16} strokeWidth={1.8} aria-hidden="true" />
						<span>RAM</span>
						<output title={`${formatMemory(systemMetrics.memoryUsedBytes)} of ${formatMemory(systemMetrics.memoryTotalBytes)} used`}>
							{systemMetrics.memoryUsage}%
						</output>
					</div>
				{:else}
					<p>Resource metrics unavailable</p>
				{/if}
			</div>
			<DropdownMenu.Separator class="vampire-menu-separator" />
			<DropdownMenu.Item class="vampire-menu-item" onSelect={openListeningPorts}>
				<Network size={16} strokeWidth={1.8} aria-hidden="true" />
				Listening ports
			</DropdownMenu.Item>
		{/snippet}
	</DropdownMenuShell>
</div>

<style>
	.terminal-system-menu { display: none; }
	.server-metrics { display: grid; gap: 0.1rem; padding: 0.2rem; }
	.server-metrics p { margin: 0; padding: 0.55rem; color: var(--color-text-tertiary); font-size: var(--text-label); }
	.server-metric { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 0.55rem; min-height: 2.4rem; padding: 0 0.45rem; border-radius: var(--radius-xs); color: var(--color-text-secondary); font-size: var(--text-label); }
	.server-metric :global(svg) { color: var(--color-text-tertiary); }
	.server-metric output { color: var(--color-text); font: inherit; font-variant-numeric: tabular-nums; }

	@media (max-width: 32rem) {
		.terminal-system-menu { display: block; }
		:global(.terminal-system-trigger) { width: 2.75rem; height: 2.75rem; border: 1px solid transparent; border-radius: var(--radius-control); }
		:global(.terminal-system-trigger:hover), :global(.terminal-system-trigger:focus-visible), :global(.terminal-system-trigger[data-state='open']) { border-color: var(--color-border); background: var(--color-surface-selected); color: var(--color-text); }
	}
</style>
