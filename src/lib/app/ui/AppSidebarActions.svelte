<script lang="ts">
import LogOut from '@lucide/svelte/icons/log-out';
import Moon from '@lucide/svelte/icons/moon';
import Network from '@lucide/svelte/icons/network';
import Sun from '@lucide/svelte/icons/sun';
import ListeningPortsDialog from '~/lib/features/system/ui/ListeningPortsDialog.svelte';
import { themeState } from '~/lib/shared/theme/theme.svelte';

let { onLogout }: { onLogout?: () => void } = $props();
let listeningPortsOpen = $state(false);
const nextTheme = $derived(themeState.current === 'dark' ? 'light' : 'dark');
</script>

<nav class="app-sidebar-actions" aria-label="Application tools">
  <strong>Vampire</strong>
  <div class="app-sidebar-action-buttons">
    <button
      type="button"
      aria-label="Inspect listening ports"
      title="Inspect listening ports"
      aria-expanded={listeningPortsOpen}
      onclick={() => listeningPortsOpen = true}
    >
      <Network size={17} strokeWidth={1.8} aria-hidden="true" />
    </button>
    <button
      type="button"
      aria-label={`Switch to ${nextTheme} theme`}
      title={`Switch to ${nextTheme} theme`}
      onclick={() => themeState.toggle()}
    >
      {#if themeState.current === 'dark'}
        <Sun size={17} strokeWidth={1.8} aria-hidden="true" />
      {:else}
        <Moon size={17} strokeWidth={1.8} aria-hidden="true" />
      {/if}
    </button>
    {#if onLogout}
      <button type="button" aria-label="Sign out" title="Sign out" onclick={onLogout}>
        <LogOut size={17} strokeWidth={1.8} aria-hidden="true" />
      </button>
    {/if}
  </div>
</nav>

{#if listeningPortsOpen}
  <ListeningPortsDialog close={() => listeningPortsOpen = false} />
{/if}

<style>
.app-sidebar-actions {
  display: flex;
  align-items: center;
  min-height: 3.15rem;
  gap: 0.6rem;
  padding: 0.45rem 0.65rem 0.45rem 1rem;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-panel);
}
.app-sidebar-actions > strong {
  margin-right: auto;
  color: var(--color-text);
  font-size: var(--text-label);
  font-weight: var(--weight-strong);
  letter-spacing: 0.01em;
}
.app-sidebar-action-buttons {
  display: flex;
  align-items: center;
  gap: 0.1rem;
}
.app-sidebar-actions button {
  display: grid;
  align-items: center;
  justify-content: center;
  width: var(--control-size-icon);
  height: var(--control-size-icon);
  padding: 0;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-tertiary);
  font: inherit;
  cursor: pointer;
}
.app-sidebar-actions button:focus-visible {
  background: var(--color-surface-hover);
  color: var(--color-text);
  outline: 2px solid var(--color-accent);
  outline-offset: -2px;
}
@media (hover: hover) {
  .app-sidebar-actions button:hover {
    background: var(--color-surface-hover);
    color: var(--color-text);
  }
}
</style>
