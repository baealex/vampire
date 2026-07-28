<script lang="ts">
	import { onMount } from 'svelte';
	import '$lib/theme/tokens.css';
	import '$lib/ui/dialog.css';
	import '$lib/ui/menu.css';
	import { themeState } from '$lib/theme/theme.svelte';
	import '../app.css';

	let { children } = $props();

	onMount(() => themeState.start());
</script>

<svelte:head>
	<meta name="theme-color" content="" />
	<meta name="mobile-web-app-capable" content="yes" />
	<meta name="apple-mobile-web-app-capable" content="yes" />
	<link rel="icon" href="/icon.svg" />
	<link rel="manifest" href="/manifest.webmanifest" />
	<link rel="apple-touch-icon" href="/icon.svg" />
	<title>Vampire</title>
</svelte:head>

{@render children()}
