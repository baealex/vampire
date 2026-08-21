<script lang="ts">
import LogOut from '@lucide/svelte/icons/log-out';
import ListOrdered from '@lucide/svelte/icons/list-ordered';
import X from '@lucide/svelte/icons/x';
import IconButton from '$lib/ui/IconButton.svelte';
import type { SessionOrderMode } from './types';

let {
  authenticationRequired,
  hasOpenSession,
  sessionOrderMode,
  workspacePreferencesError,
  onLogout,
  onClose,
  onOrderModeChange,
}: {
  authenticationRequired: boolean;
  hasOpenSession: boolean;
  sessionOrderMode: SessionOrderMode;
  workspacePreferencesError: string;
  onLogout: () => void;
  onClose: () => void;
  onOrderModeChange: (mode: SessionOrderMode) => void;
} = $props();
</script>

{#if authenticationRequired || hasOpenSession}
  <header class="section-header" class:mobile-only-header={!authenticationRequired}>
    <div class="section-actions">
      {#if authenticationRequired}
        <IconButton label="Sign out" onclick={onLogout}>
          <LogOut size={18} strokeWidth={1.8} aria-hidden="true" />
        </IconButton>
      {/if}
      {#if hasOpenSession}
        <span class="navigator-close">
          <IconButton label="Close workspace navigator" title="Close workspaces" onclick={onClose}>
            <X size={19} strokeWidth={1.8} aria-hidden="true" />
          </IconButton>
        </span>
      {/if}
    </div>
  </header>
{/if}

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
</div>

<style>
.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.65rem;
  min-height: 3.25rem;
  padding: 0.65rem 1rem;
}
.section-actions {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: flex-end;
  gap: 0.25rem;
}
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
.session-order-hint:hover {
  color: var(--color-text-secondary);
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
.session-order-control button:hover {
  color: var(--color-text);
}
.session-order-control button::after {
  position: absolute;
  right: 0;
  bottom: 0.28rem;
  left: 0;
  height: 2px;
  background: transparent;
  content: '';
}
.session-order-control button.active {
  color: var(--color-text);
}
.session-order-control button.active::after {
  background: var(--color-accent);
}
.navigator-close {
  display: none;
}

@media (max-width: 63.999rem) {
  .section-header.mobile-only-header {
    display: flex;
  }
  .session-order-control button {
    min-height: 2rem;
  }
  .navigator-close {
    display: grid;
  }
}

@media (min-width: 64rem) {
  .section-header.mobile-only-header {
    display: none;
  }
}

@media (max-width: 24rem) {
  .section-header {
    align-items: flex-start;
    flex-wrap: wrap;
    min-height: 0;
    gap: 0.4rem 0.65rem;
    padding-block: 0.6rem;
  }
  .section-actions {
    flex-basis: 100%;
  }
  .section-actions {
    justify-content: flex-end;
  }
}
</style>
