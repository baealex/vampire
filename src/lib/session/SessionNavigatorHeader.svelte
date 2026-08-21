<script lang="ts">
import ListOrdered from '@lucide/svelte/icons/list-ordered';
import X from '@lucide/svelte/icons/x';
import ToolbarButton from '$lib/ui/ToolbarButton.svelte';
import type { SessionOrderMode } from './types';

let {
  hasOpenSession,
  sessionOrderMode,
  workspacePreferencesError,
  onClose,
  onOrderModeChange,
}: {
  hasOpenSession: boolean;
  sessionOrderMode: SessionOrderMode;
  workspacePreferencesError: string;
  onClose: () => void;
  onOrderModeChange: (mode: SessionOrderMode) => void;
} = $props();
</script>

<div class="session-order-toolbar">
  <span class="session-order-hint" title="Workspace ordering" aria-hidden="true">
    <ListOrdered size={15} strokeWidth={1.8} />
  </span>
  <div class="session-order-control" role="group" aria-label="Workspace ordering">
    <button
      type="button"
      class:active={sessionOrderMode === 'activity'}
      onclick={() => onOrderModeChange('activity')}
      aria-pressed={sessionOrderMode === 'activity'}
      aria-label="Group workspaces by status"
      title="Working and review-needed workspaces first"
    >
      Smart
    </button>
    <button
      type="button"
      class:active={sessionOrderMode === 'manual'}
      onclick={() => onOrderModeChange('manual')}
      aria-pressed={sessionOrderMode === 'manual'}
      aria-label="Arrange workspaces manually"
      title="Drag rows to reorder"
    >
      Manual
    </button>
  </div>
  {#if workspacePreferencesError}
    <span class="session-order-error" role="alert">{workspacePreferencesError}</span>
  {/if}
  {#if hasOpenSession}
    <span class="navigator-close">
      <ToolbarButton label="Close workspace navigator" title="Close workspaces" onclick={onClose} compact>
        <X size={17} strokeWidth={1.8} aria-hidden="true" />
      </ToolbarButton>
    </span>
  {/if}
</div>

<style>
.session-order-toolbar {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  min-width: 0;
  padding: 0.4rem 1rem 0.45rem;
  color: var(--color-text-tertiary);
  font-size: var(--text-caption);
}
.session-order-error {
  min-width: 0;
  margin-left: auto;
  overflow: hidden;
  color: var(--color-danger-text);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.session-order-hint {
  display: grid;
  flex: 0 0 auto;
  place-items: center;
  width: 1.1rem;
  color: var(--color-text-tertiary);
}
.session-order-control {
  display: inline-flex;
  align-items: stretch;
  gap: 0.75rem;
}
.session-order-control button {
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
.session-order-control button::after {
  position: absolute;
  right: 0;
  bottom: 0.28rem;
  left: 0;
  height: 2px;
  background: transparent;
  content: "";
}
.session-order-control button.active {
  color: var(--color-text);
}
.session-order-control button.active::after {
  background: var(--color-accent);
}

@media (hover: hover) {
  .session-order-hint:hover {
    color: var(--color-text-secondary);
  }
  .session-order-control button:hover {
    color: var(--color-text);
  }
}
.navigator-close {
  display: none;
  flex: 0 0 auto;
  margin-left: auto;
}

@media (max-width: 63.999rem) {
  .session-order-control button {
    min-height: 2rem;
  }
  .navigator-close {
    display: grid;
  }
}

@media (max-width: 24rem) {
  .session-order-toolbar {
    gap: 0.35rem;
    padding-inline: 0.75rem;
  }
  .session-order-control {
    gap: 0.55rem;
  }
}
</style>
