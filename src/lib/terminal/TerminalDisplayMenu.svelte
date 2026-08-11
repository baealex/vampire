<script lang="ts">
	import { DropdownMenu } from 'bits-ui';
	import Minus from '@lucide/svelte/icons/minus';
	import Plus from '@lucide/svelte/icons/plus';
	import Type from '@lucide/svelte/icons/type';
	import DropdownMenuShell from '$lib/ui/DropdownMenuShell.svelte';

	let {
		fontSize,
		minimumFontSize,
		maximumFontSize,
		decreaseFontSize,
		increaseFontSize
	}: {
		fontSize: number;
		minimumFontSize: number;
		maximumFontSize: number;
		decreaseFontSize: () => void;
		increaseFontSize: () => void;
	} = $props();

	function keepOpen(event: Event, change: () => void) {
		event.preventDefault();
		change();
	}
</script>

<div class="terminal-display-menu">
	<DropdownMenuShell
		align="end"
		triggerClass="vampire-menu-trigger terminal-display-trigger"
		triggerLabel="Terminal display settings"
	>
		{#snippet trigger()}
			<Type size={17} strokeWidth={1.8} aria-hidden="true" />
		{/snippet}

		{#snippet children()}
			<div class="vampire-menu-heading" role="presentation">
				<strong>Terminal display</strong>
				<span>Text size: {fontSize}px</span>
			</div>
			<DropdownMenu.Separator class="vampire-menu-separator" />
			<DropdownMenu.Item
				class="vampire-menu-item"
				disabled={fontSize <= minimumFontSize}
				onSelect={(event) => keepOpen(event, decreaseFontSize)}
			>
				<Minus size={15} strokeWidth={2} aria-hidden="true" />
				Decrease text size
			</DropdownMenu.Item>
			<DropdownMenu.Item
				class="vampire-menu-item"
				disabled={fontSize >= maximumFontSize}
				onSelect={(event) => keepOpen(event, increaseFontSize)}
			>
				<Plus size={15} strokeWidth={2} aria-hidden="true" />
				Increase text size
			</DropdownMenu.Item>
		{/snippet}
	</DropdownMenuShell>
</div>

<style>
	:global(.terminal-display-trigger) { width: 2.35rem; height: 2.35rem; border: 1px solid transparent; border-radius: var(--radius-control); }
	:global(.terminal-display-trigger:hover), :global(.terminal-display-trigger:focus-visible), :global(.terminal-display-trigger[data-state='open']) { border-color: var(--color-border-strong); background: transparent; color: var(--color-text); outline: none; }
</style>
