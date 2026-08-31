<script lang="ts">
import StatusPluginBar from '~/lib/features/status/ui/StatusPluginBar.svelte';
import type { StatusPluginSnapshot } from '~/lib/shared/contracts/status-plugin';

let {
  plugins = [],
  dismissPopovers = false,
  onManageStatusWidgets = () => undefined,
}: {
  plugins?: StatusPluginSnapshot[];
  dismissPopovers?: boolean;
  onManageStatusWidgets?: () => void;
} = $props();
</script>

<section class="global-status-shell" aria-label="Server-wide system status">
  <StatusPluginBar {plugins} {dismissPopovers} onManage={onManageStatusWidgets} />
</section>

<style>
.global-status-shell {
  position: relative;
  z-index: 30;
  padding-top: env(safe-area-inset-top);
  background: var(--color-panel);
}
.global-status-shell :global(.status-plugin-bar) {
  width: 100%;
  min-width: 0;
  background: var(--color-panel);
}
.global-status-shell :global(.status-plugin-list) {
  min-width: max-content;
}
</style>
