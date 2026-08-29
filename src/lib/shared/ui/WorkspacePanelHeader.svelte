<script lang="ts">
import X from '@lucide/svelte/icons/x';
import type { Snippet } from 'svelte';

let {
  title,
  titleId,
  subtitle,
  subtitleMonospace = false,
  close,
  closeLabel = 'Close panel',
  actions,
}: {
  title: string;
  titleId?: string;
  subtitle?: string;
  subtitleMonospace?: boolean;
  close?: () => void;
  closeLabel?: string;
  actions?: Snippet;
} = $props();
</script>

<header class="workspace-panel-header">
  <div class="workspace-panel-title">
    <strong id={titleId}>{title}</strong>
    {#if subtitle}
      <span class:monospace={subtitleMonospace} title={subtitle}>{subtitle}</span>
    {/if}
  </div>
  {#if actions || close}
    <div class="workspace-panel-actions">
      {#if actions}
        {@render actions()}
      {/if}
      {#if close}
        <button type="button" class="workspace-panel-close" onclick={close} aria-label={closeLabel} title={closeLabel}>
          <X size={17} strokeWidth={1.9} aria-hidden="true" />
        </button>
      {/if}
    </div>
  {/if}
</header>

<style>
.workspace-panel-header {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  min-height: 4rem;
  padding: 0.75rem 0.8rem 0.75rem 1rem;
  border-bottom: 1px solid var(--color-border);
  box-sizing: border-box;
}
.workspace-panel-title {
  display: grid;
  min-width: 0;
  gap: 0.15rem;
}
.workspace-panel-title strong,
.workspace-panel-title span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.workspace-panel-title strong {
  font-size: var(--text-title);
  font-weight: var(--weight-strong);
  line-height: var(--leading-tight);
}
.workspace-panel-title span {
  color: var(--color-text-tertiary);
  font-size: var(--text-caption);
  line-height: var(--leading-ui);
}
.workspace-panel-title span.monospace {
  font-family: var(--font-mono);
}
.workspace-panel-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 0.15rem;
}
.workspace-panel-close {
  display: grid;
  place-items: center;
  width: var(--control-height-md);
  height: var(--control-height-md);
  padding: 0;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
}
@media (hover: hover) {
  .workspace-panel-close:hover {
    background: var(--color-surface-raised);
    color: var(--color-text);
  }
}
</style>
