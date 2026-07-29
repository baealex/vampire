<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		label,
		title = label,
		type = 'button',
		disabled = false,
		onclick,
		children
	}: {
		label: string;
		title?: string;
		type?: 'button' | 'submit' | 'reset';
		disabled?: boolean;
		onclick?: (event: MouseEvent) => void;
		children: Snippet;
	} = $props();
</script>

<button {type} {disabled} {onclick} aria-label={label} {title}>
	{@render children()}
</button>

<style>
	button {
		display: grid;
		place-items: center;
		width: var(--control-size-icon);
		height: var(--control-size-icon);
		padding: 0;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--color-text-secondary);
		cursor: pointer;
	}

	button:hover { background: var(--color-surface-raised); color: var(--color-text); }
	button:disabled { cursor: wait; opacity: 0.55; }
</style>
