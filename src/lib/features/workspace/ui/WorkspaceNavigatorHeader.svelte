<script lang="ts">
import ListOrdered from '@lucide/svelte/icons/list-ordered';
import X from '@lucide/svelte/icons/x';
import ToolbarButton from '~/lib/shared/ui/ToolbarButton.svelte';
import type { WorkspaceOrderMode } from '~/lib/shared/contracts/workspace';

let {
  hasOpenWorkspace,
  workspaceOrderMode,
  workspacePreferencesError,
  onClose,
  onOrderModeChange,
}: {
  hasOpenWorkspace: boolean;
  workspaceOrderMode: WorkspaceOrderMode;
  workspacePreferencesError: string;
  onClose: () => void;
  onOrderModeChange: (mode: WorkspaceOrderMode) => void;
} = $props();
</script>

<div class="workspace-order-toolbar">
  <span class="workspace-order-hint" title="Workspace ordering" aria-hidden="true">
    <ListOrdered size={15} strokeWidth={1.8} />
  </span>
  <div class="workspace-order-control" role="group" aria-label="Workspace ordering">
    <button
      type="button"
      class:active={workspaceOrderMode === 'activity'}
      onclick={() => onOrderModeChange('activity')}
      aria-pressed={workspaceOrderMode === 'activity'}
      aria-label="Group workspaces by status"
      title="Working and review-needed workspaces first"
    >
      Smart
    </button>
    <button
      type="button"
      class:active={workspaceOrderMode === 'manual'}
      onclick={() => onOrderModeChange('manual')}
      aria-pressed={workspaceOrderMode === 'manual'}
      aria-label="Arrange workspaces manually"
      title="Drag rows to reorder"
    >
      Manual
    </button>
  </div>
  {#if workspacePreferencesError}
    <span class="workspace-order-error" role="alert">{workspacePreferencesError}</span>
  {/if}
  {#if hasOpenWorkspace}
    <span class="navigator-close">
      <ToolbarButton label="Close workspace navigator" title="Close workspaces" onclick={onClose} compact>
        <X size={17} strokeWidth={1.8} aria-hidden="true" />
      </ToolbarButton>
    </span>
  {/if}
</div>

<style>
.workspace-order-toolbar {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  min-width: 0;
  padding: 0.4rem 1rem 0.45rem;
  color: var(--color-text-tertiary);
  font-size: var(--text-caption);
}
.workspace-order-error {
  min-width: 0;
  margin-left: auto;
  overflow: hidden;
  color: var(--color-danger-text);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.workspace-order-hint {
  display: grid;
  flex: 0 0 auto;
  place-items: center;
  width: 1.1rem;
  color: var(--color-text-tertiary);
}
.workspace-order-control {
  display: inline-flex;
  align-items: stretch;
  gap: 0.75rem;
}
.workspace-order-control button {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 1.95rem;
  padding: 0.1rem 0.05rem 0.15rem;
  border: 0;
  background: transparent;
  color: var(--color-text-tertiary);
  font: inherit;
  font-weight: var(--weight-medium);
  cursor: pointer;
}
.workspace-order-control button::after {
  position: absolute;
  right: 0;
  bottom: 0.28rem;
  left: 0;
  height: 2px;
  background: transparent;
  content: "";
}
.workspace-order-control button.active {
  color: var(--color-text);
}
.workspace-order-control button.active::after {
  background: var(--color-accent);
}

@media (hover: hover) {
  .workspace-order-hint:hover {
    color: var(--color-text-secondary);
  }
  .workspace-order-control button:hover {
    color: var(--color-text);
  }
}
.navigator-close {
  display: none;
  flex: 0 0 auto;
  margin-left: auto;
}

@media (max-width: 63.999rem) {
  .workspace-order-control button {
    min-height: 2rem;
  }
  .navigator-close {
    display: grid;
  }
}

@media (max-width: 24rem) {
  .workspace-order-toolbar {
    gap: 0.35rem;
    padding-inline: 0.75rem;
  }
  .workspace-order-control {
    gap: 0.55rem;
  }
}
</style>
