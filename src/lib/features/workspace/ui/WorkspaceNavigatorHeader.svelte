<script lang="ts">
import type { Snippet } from 'svelte';
import Plus from '@lucide/svelte/icons/plus';
import X from '@lucide/svelte/icons/x';
import ToolbarButton from '~/lib/shared/ui/ToolbarButton.svelte';
import type { WorkspaceOrderMode } from '~/lib/shared/contracts/workspace';

let {
  hasOpenWorkspace,
  workspaceOrderMode,
  workspacePreferencesError,
  onClose,
  onOrderModeChange,
  onNewWorkspace,
  tools,
}: {
  hasOpenWorkspace: boolean;
  workspaceOrderMode: WorkspaceOrderMode;
  workspacePreferencesError: string;
  onClose: () => void;
  onOrderModeChange: (mode: WorkspaceOrderMode) => void;
  onNewWorkspace: () => void;
  tools?: Snippet;
} = $props();
</script>

{#if tools}
  <div class="workspace-tools">{@render tools()}</div>
{/if}

<div class="workspace-navigator-heading">
  <strong>Workspaces</strong>
  <button
    class="new-workspace-button"
    type="button"
    aria-label="New workspace"
    title="New workspace"
    onclick={onNewWorkspace}
  >
    <Plus size={17} strokeWidth={2} aria-hidden="true" />
  </button>
  {#if hasOpenWorkspace}
    <span class="navigator-close">
      <ToolbarButton label="Close workspace navigator" title="Close workspaces" onclick={onClose} compact>
        <X size={17} strokeWidth={1.8} aria-hidden="true" />
      </ToolbarButton>
    </span>
  {/if}
</div>

<div class="workspace-order-toolbar">
  <span class="workspace-order-label">Order by</span>
  <div class="workspace-order-control" role="group" aria-label="Workspace ordering">
    <button
      type="button"
      class:active={workspaceOrderMode === 'activity'}
      onclick={() => onOrderModeChange('activity')}
      aria-pressed={workspaceOrderMode === 'activity'}
      aria-label="Group workspaces by status"
      title="Working and review-needed workspaces first"
    >
      Activity
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
</div>

<style>
.workspace-navigator-heading {
  display: flex;
  align-items: center;
  min-height: 3rem;
  gap: 0.2rem;
  padding: 0.4rem 0.65rem 0.4rem 1rem;
}
.workspace-navigator-heading > strong {
  margin-right: auto;
  color: var(--color-text);
  font-size: var(--text-body);
  font-weight: var(--weight-strong);
}
.new-workspace-button {
  display: grid;
  place-items: center;
  width: var(--control-size-icon);
  height: var(--control-size-icon);
  padding: 0;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-secondary);
  font: inherit;
  cursor: pointer;
}
.new-workspace-button:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}
.workspace-order-toolbar {
  display: flex;
  align-items: center;
  gap: 0.55rem;
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
.workspace-order-label {
  flex: 0 0 auto;
  color: var(--color-text-tertiary);
  font-size: var(--text-caption);
  font-weight: var(--weight-medium);
}
.workspace-order-control {
  display: inline-flex;
  align-items: stretch;
  gap: 0.8rem;
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
  .new-workspace-button:hover {
    background: var(--color-surface-hover);
    color: var(--color-text);
  }
  .workspace-order-control button:hover {
    color: var(--color-text);
  }
}
.navigator-close {
  display: none;
  flex: 0 0 auto;
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
  .workspace-navigator-heading {
    padding-left: 0.75rem;
  }
  .workspace-order-toolbar {
    gap: 0.35rem;
    padding-inline: 0.75rem;
  }
  .workspace-order-control {
    gap: 0.6rem;
  }
}
</style>
