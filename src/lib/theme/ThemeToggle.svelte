<script lang="ts">
	import Moon from '@lucide/svelte/icons/moon';
	import Sun from '@lucide/svelte/icons/sun';
	import { themeState } from './theme.svelte';

	const nextTheme = $derived(themeState.current === 'dark' ? 'light' : 'dark');
</script>

<button
	type="button"
	class="theme-toggle"
	onclick={() => themeState.toggle()}
	aria-label={`Switch to ${nextTheme} theme`}
	title={`Switch to ${nextTheme} theme`}
>
	{#if themeState.current === 'dark'}
		<Sun size={18} strokeWidth={1.8} aria-hidden="true" />
	{:else}
		<Moon size={18} strokeWidth={1.8} aria-hidden="true" />
	{/if}
</button>

<style>
	.theme-toggle { display: grid; place-items: center; width: 2.6rem; height: 2.6rem; padding: 0; border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--color-text-secondary); cursor: pointer; }
	.theme-toggle:hover { background: var(--color-surface-raised); color: var(--color-text); }
</style>
