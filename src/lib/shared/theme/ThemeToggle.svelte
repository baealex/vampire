<script lang="ts">
import Moon from '@lucide/svelte/icons/moon';
import Sun from '@lucide/svelte/icons/sun';
import ToolbarButton from '~/lib/shared/ui/ToolbarButton.svelte';
import { themeState } from './theme.svelte';

let { compact = false }: { compact?: boolean } = $props();
const nextTheme = $derived(themeState.current === 'dark' ? 'light' : 'dark');
</script>

<ToolbarButton
  {compact}
  onclick={() => themeState.toggle()}
  label={`Switch to ${nextTheme} theme`}
  title={`Switch to ${nextTheme} theme`}
>
  {#if themeState.current === 'dark'}
    <Sun size={18} strokeWidth={1.8} aria-hidden="true" />
  {:else}
    <Moon size={18} strokeWidth={1.8} aria-hidden="true" />
  {/if}
</ToolbarButton>
