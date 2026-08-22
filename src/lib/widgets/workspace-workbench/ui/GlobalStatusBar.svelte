<script lang="ts">
import Network from '@lucide/svelte/icons/network';
import LogOut from '@lucide/svelte/icons/log-out';
import ListeningPortsDialog from '~/lib/features/system/ui/ListeningPortsDialog.svelte';
import ThemeToggle from '~/lib/shared/theme/ThemeToggle.svelte';
import ToolbarButton from '~/lib/shared/ui/ToolbarButton.svelte';
import StatusPluginBar from '~/lib/features/status/ui/StatusPluginBar.svelte';
import type { StatusPluginSnapshot } from '~/lib/shared/contracts/status-plugin';

let {
  plugins = [],
  onLogout,
  dismissPopovers = false,
}: {
  plugins?: StatusPluginSnapshot[];
  onLogout?: () => void;
  dismissPopovers?: boolean;
} = $props();
let listeningPortsOpen = $state(false);
</script>

<section class="global-status-shell" aria-label="Server-wide system status">
  <div class="global-status-rail">
    <StatusPluginBar {plugins} {dismissPopovers} />
    <div class="global-status-actions">
      <ToolbarButton
        compact
        text="Ports"
        label="Inspect listening ports"
        title="Inspect listening ports"
        active={listeningPortsOpen}
        expanded={listeningPortsOpen}
        onclick={() => (listeningPortsOpen = true)}
      >
        <Network size={15} strokeWidth={1.8} aria-hidden="true" />
      </ToolbarButton>
      <ThemeToggle compact />
      {#if onLogout}
        <ToolbarButton compact label="Sign out" title="Sign out" onclick={onLogout}>
          <LogOut size={18} strokeWidth={1.8} aria-hidden="true" />
        </ToolbarButton>
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
</style>
