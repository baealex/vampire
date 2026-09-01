<script lang="ts">
import Network from '@lucide/svelte/icons/network';
import Settings2 from '@lucide/svelte/icons/settings-2';

let { onPorts, onSettings }: { onPorts: () => void; onSettings: () => void } = $props();
</script>

<nav class="app-sidebar-actions" aria-label="Application">
  <img class="app-sidebar-logo" src="/icon.svg" alt="Vampire">
  <button type="button" aria-label="Inspect listening ports" title="Listening ports" onclick={onPorts}>
    <Network size={17} strokeWidth={1.8} aria-hidden="true" />
  </button>
  <button type="button" aria-label="Open settings" title="Settings" onclick={onSettings}>
    <Settings2 size={17} strokeWidth={1.8} aria-hidden="true" />
  </button>
</nav>

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
.app-sidebar-logo {
  display: block;
  width: 1.9rem;
  height: 1.9rem;
  margin-right: auto;
  border-radius: 0.5rem;
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
