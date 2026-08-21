<script lang="ts">
import Network from '@lucide/svelte/icons/network';
import LogOut from '@lucide/svelte/icons/log-out';
import ListeningPortsDialog from '$lib/system/ListeningPortsDialog.svelte';
import ThemeToggle from '$lib/theme/ThemeToggle.svelte';
import IconButton from '$lib/ui/IconButton.svelte';
import StatusPluginBar from './StatusPluginBar.svelte';
import type { StatusPluginSnapshot } from './status-plugin';

let {
  plugins = [],
  onLogout,
}: {
  plugins?: StatusPluginSnapshot[];
  onLogout?: () => void;
} = $props();
let listeningPortsOpen = $state(false);
</script>

<section class="global-status-shell" aria-label="Server-wide system status">
  <div class="global-status-rail">
    <StatusPluginBar {plugins} />
    <div class="global-status-actions">
      <button
        type="button"
        class="global-status-ports"
        class:active={listeningPortsOpen}
        onclick={() => (listeningPortsOpen = true)}
        aria-label="Inspect listening ports"
        aria-expanded={listeningPortsOpen}
        title="Inspect listening ports"
      >
        <Network size={15} strokeWidth={1.8} aria-hidden="true" />
        <span>Ports</span>
      </button>
      <ThemeToggle compact />
      {#if onLogout}
        <IconButton compact label="Sign out" title="Sign out" onclick={onLogout}>
          <LogOut size={18} strokeWidth={1.8} aria-hidden="true" />
        </IconButton>
      {/if}
    </div>
  </div>
</section>

{#if listeningPortsOpen}
  <ListeningPortsDialog close={() => (listeningPortsOpen = false)} />
{/if}

<style>
.global-status-shell {
  position: relative;
  z-index: 30;
  padding-top: env(safe-area-inset-top);
  background: var(--color-panel);
}
.global-status-rail {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  width: 100%;
  min-width: 0;
  border-bottom: 1px solid var(--color-divider-subtle);
  background: var(--color-panel);
}
.global-status-rail :global(.status-plugin-bar) {
  width: 100%;
  min-width: 0;
  border-bottom: 0;
  background: var(--color-panel);
}
.global-status-rail :global(.status-plugin-list) {
  min-width: max-content;
}
.global-status-actions {
  display: flex;
  align-items: center;
  border-left: 1px solid var(--color-border);
}
.global-status-actions :global(button + button) {
  position: relative;
}
.global-status-actions :global(button + button)::before {
  position: absolute;
  top: 0.45rem;
  bottom: 0.45rem;
  left: 0;
  width: 1px;
  background: var(--color-border);
  content: "";
}
.global-status-ports {
  display: grid;
  grid-auto-flow: column;
  align-items: center;
  gap: 0.38rem;
  min-width: 4.7rem;
  min-height: 2.15rem;
  padding: 0 max(0.7rem, env(safe-area-inset-right)) 0 0.72rem;
  border: 0;
  border-left: 0;
  background: transparent;
  color: var(--color-text-tertiary);
  font: inherit;
  font-size: var(--text-caption);
  font-weight: var(--weight-medium);
  cursor: pointer;
}
.global-status-ports:hover,
.global-status-ports:focus-visible,
.global-status-ports.active {
  background: var(--color-surface-hover);
  color: var(--color-text);
  outline: none;
}

@media (max-width: 32rem) {
  .global-status-ports {
    min-width: 2.65rem;
    padding-inline: 0.55rem max(0.55rem, env(safe-area-inset-right));
  }
  .global-status-ports span {
    display: none;
  }
}
</style>
