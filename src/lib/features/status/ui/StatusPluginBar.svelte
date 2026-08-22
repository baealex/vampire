<script lang="ts">
import { onMount } from 'svelte';
import { Popover } from 'bits-ui';
import Check from '@lucide/svelte/icons/check';
import ExternalLink from '@lucide/svelte/icons/external-link';
import AlertTriangle from '@lucide/svelte/icons/triangle-alert';
import Plus from '@lucide/svelte/icons/plus';
import type { StatusPluginMenuEntry, StatusPluginSnapshot } from '~/lib/shared/contracts/status-plugin.ts';
import StatusPluginSettings from './StatusPluginSettings.svelte';

type StatusPluginItem = Extract<StatusPluginMenuEntry, { type: 'item' }>;

let {
  plugins,
  dismissPopovers = false,
}: {
  plugins: StatusPluginSnapshot[];
  dismissPopovers?: boolean;
} = $props();
let settingsOpen = $state(false);
let openPluginId = $state<string>();
let compactViewport = $state(false);
let closedByOutsidePointer = false;
const popoverAlignOffset = $derived(compactViewport ? 8 : 0);

onMount(() => {
  const media = window.matchMedia('(max-width: 32rem)');
  const sync = () => (compactViewport = media.matches);
  sync();
  media.addEventListener('change', sync);
  return () => media.removeEventListener('change', sync);
});

function timestampLabel(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(timestamp));
}

function pluginLabel(plugin: StatusPluginSnapshot): string {
  if (plugin.state === 'loading') return `${plugin.name} is loading`;
  const value = plugin.text ? `: ${plugin.text}` : '';
  const error = plugin.error ? `. ${plugin.error}` : '';
  return `${plugin.name}${value}${error}`;
}

function handleInteractOutside() {
  closedByOutsidePointer = true;
}

function handleCloseAutoFocus(event: Event) {
  if (!closedByOutsidePointer) return;
  closedByOutsidePointer = false;
  event.preventDefault();
}

function handlePopoverOpenChange(pluginId: string, open: boolean) {
  openPluginId = open ? pluginId : openPluginId === pluginId ? undefined : openPluginId;
}

$effect(() => {
  if (dismissPopovers) openPluginId = undefined;
});
</script>

{#snippet menuItemContent(entry: StatusPluginItem)}
  <div class="status-plugin-menu-item__content">
    <div class="status-plugin-menu-item__title">
      {#if entry.checked}
        <Check size={13} strokeWidth={2.2} aria-hidden="true" />
      {/if}
      <span>{entry.text}</span>
      {#if entry.badge}
        <em>{entry.badge}</em>
      {/if}
    </div>
    {#if entry.detail}
      <small>{entry.detail}</small>
    {/if}
    {#if entry.time}
      <small>{entry.time.label ?? 'At'} {timestampLabel(entry.time.at)}</small>
    {/if}
  </div>
  {#if entry.value}
    <output>{entry.value}</output>
  {/if}
  {#if entry.href}
    <ExternalLink class="status-plugin-menu-item__external" size={12} strokeWidth={1.8} aria-hidden="true" />
  {/if}
  {#if entry.progress !== undefined}
    <div
      class="status-plugin-menu-progress"
      role="progressbar"
      aria-label={`${entry.text} progress`}
      aria-valuenow={entry.progress}
      aria-valuemin="0"
      aria-valuemax="100"
    >
      <span style={`width: ${entry.progress}%`}></span>
    </div>
  {/if}
{/snippet}

<section class="status-plugin-bar" aria-label="Server status plugins">
  <div class="status-plugin-scroll">
    <div class="status-plugin-list">
      {#each plugins as plugin (plugin.id)}
        <Popover.Root
          open={openPluginId === plugin.id}
          onOpenChange={(open) => handlePopoverOpenChange(plugin.id, open)}
        >
          <Popover.Trigger
            type="button"
            class={`status-plugin${plugin.state === 'error' || plugin.state === 'stale' ? ' status-plugin--problem' : ''}`}
            data-tone={plugin.tone ?? 'neutral'}
            aria-label={pluginLabel(plugin)}
            title={plugin.tooltip}
          >
            <span>{plugin.name}</span>
            <output>{plugin.state === 'loading' ? '…' : (plugin.text ?? '—')}</output>
            {#if plugin.state === 'error' || plugin.state === 'stale'}
              <AlertTriangle size={12} strokeWidth={2} aria-hidden="true" />
            {/if}
          </Popover.Trigger>
          {#if !dismissPopovers}
            <Popover.Portal>
              <Popover.Content
                class="status-plugin-popover"
                side="bottom"
                align="start"
                sideOffset={6}
                alignOffset={popoverAlignOffset}
                trapFocus={false}
                onInteractOutside={handleInteractOutside}
                onCloseAutoFocus={handleCloseAutoFocus}
              >
                <div class="status-plugin-popover__header">
                  <strong>{plugin.name}</strong>
                  <output>{plugin.state === 'loading' ? 'Loading…' : (plugin.text ?? '—')}</output>
                </div>
                {#if plugin.progress !== undefined}
                  <div
                    class="status-plugin-progress"
                    role="progressbar"
                    aria-label={`${plugin.name} usage`}
                    aria-valuenow={plugin.progress}
                    aria-valuemin="0"
                    aria-valuemax="100"
                  >
                    <span style={`width: ${plugin.progress}%`}></span>
                  </div>
                {/if}
                {#if plugin.menu?.length}
                  <div class="status-plugin-menu" role="list">
                    {#each plugin.menu as entry}
                      {#if entry.type === 'separator'}
                        <div class="status-plugin-menu-separator" role="separator"></div>
                      {:else if entry.type === 'heading'}
                        <div class="status-plugin-menu-heading">
                          <strong>{entry.text}</strong>
                          {#if entry.badge}
                            <span>{entry.badge}</span>
                          {/if}
                        </div>
                      {:else}
                        <div
                          class="status-plugin-menu-item"
                          data-tone={entry.tone ?? 'neutral'}
                          style={`--status-menu-indent: ${(entry.indent ?? 0) * 0.8}rem`}
                          role="listitem"
                        >
                          {#if entry.href}
                            <a href={entry.href} target="_blank" rel="noreferrer">{@render menuItemContent(entry)}</a>
                          {:else}
                            <div>{@render menuItemContent(entry)}</div>
                          {/if}
                        </div>
                      {/if}
                    {/each}
                  </div>
                {/if}
                {#if plugin.error}
                  <p class="status-plugin-error" role="status">{plugin.error}</p>
                {/if}
                <div class="status-plugin-times">
                  {#if plugin.updatedAt}
                    <span>Updated {timestampLabel(plugin.updatedAt)}</span>
                  {/if}
                </div>
              </Popover.Content>
            </Popover.Portal>
          {/if}
        </Popover.Root>
      {/each}
      <button
        type="button"
        class="status-plugin-add"
        onclick={() => (settingsOpen = true)}
        aria-label="Manage status widgets"
        aria-expanded={settingsOpen}
        title="Manage status widgets"
      >
        <Plus size={14} strokeWidth={1.9} aria-hidden="true" />
      </button>
    </div>
  </div>
</section>

{#if settingsOpen}
  <StatusPluginSettings close={() => (settingsOpen = false)} />
{/if}

<style>
.status-plugin-bar {
  display: block;
  min-width: 0;
  min-height: 2.15rem;
  border-bottom: 1px solid var(--color-divider-subtle);
  background: var(--color-panel);
  color: var(--color-text-secondary);
}
.status-plugin-scroll {
  min-width: 0;
  overflow-x: auto;
  overscroll-behavior-x: contain;
  scrollbar-width: none;
}
.status-plugin-scroll::-webkit-scrollbar {
  display: none;
}
.status-plugin-list {
  display: flex;
  align-items: stretch;
  width: max-content;
  min-width: 100%;
  padding-left: 0;
}
:global(.status-plugin) {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 0.34rem;
  min-height: 2.15rem;
  padding: 0 0.58rem;
  border: 0;
  border-right: 1px solid var(--color-divider-subtle);
  background: transparent;
  color: var(--color-text-secondary);
  font: inherit;
  font-size: var(--text-caption);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  cursor: pointer;
}
:global(.status-plugin:focus-visible) {
  background: var(--color-surface-hover);
  color: var(--color-text);
}
@media (hover: hover) {
  :global(.status-plugin:hover) {
    background: var(--color-surface-hover);
    color: var(--color-text);
  }
}
:global(.status-plugin > span) {
  color: var(--color-text-tertiary);
  font-weight: var(--weight-medium);
}
:global(.status-plugin output) {
  color: var(--color-text);
  font: inherit;
}
:global(.status-plugin[data-tone="success"] output) {
  color: var(--color-success-text);
}
:global(.status-plugin[data-tone="warning"] output),
:global(.status-plugin--problem) {
  color: var(--color-warning-accent);
}
:global(.status-plugin[data-tone="danger"] output),
:global(.status-plugin--problem > svg) {
  color: var(--color-danger-text);
}
.status-plugin-add {
  display: grid;
  flex: 0 0 auto;
  place-items: center;
  width: 2.15rem;
  min-height: 2.15rem;
  padding: 0;
  border: 0;
  border-left: 1px solid var(--color-divider-subtle);
  background: transparent;
  color: var(--color-text-tertiary);
  cursor: pointer;
}
.status-plugin-add:focus-visible {
  background: var(--color-surface-hover);
  color: var(--color-text);
  outline: none;
}
@media (hover: hover) {
  .status-plugin-add:hover {
    background: var(--color-surface-hover);
    color: var(--color-text);
    outline: none;
  }
}
:global(.status-plugin-popover) {
  box-sizing: border-box;
  z-index: 70;
  display: grid;
  gap: 0.55rem;
  width: max-content;
  min-width: 13rem;
  max-width: min(24rem, calc(100vw - 1rem));
  padding: 0.7rem;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-md);
  outline: none;
  background: var(--color-surface);
  box-shadow: var(--shadow-popover);
  color: var(--color-text-secondary);
  font-size: var(--text-caption);
}
:global(.status-plugin-popover__header) {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
}
:global(.status-plugin-popover__header strong) {
  color: var(--color-text);
  font-weight: var(--weight-medium);
}
:global(.status-plugin-popover__header output) {
  color: var(--color-text);
  font: inherit;
  font-weight: var(--weight-strong);
  font-variant-numeric: tabular-nums;
}
:global(.status-plugin-progress) {
  height: 0.3rem;
  overflow: hidden;
  border-radius: var(--radius-pill);
  background: var(--color-surface-raised);
}
:global(.status-plugin-progress span) {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--color-accent);
}
:global(.status-plugin-menu) {
  display: grid;
  overflow: hidden;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
}
:global(.status-plugin-menu-heading) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.48rem 0.55rem;
  border-bottom: 1px solid var(--color-border-subtle);
  background: var(--color-surface);
  color: var(--color-text-secondary);
}
:global(.status-plugin-menu-heading strong) {
  min-width: 0;
  overflow-wrap: anywhere;
  font-weight: var(--weight-strong);
}
:global(.status-plugin-menu-heading span) {
  flex: 0 0 auto;
  padding: 0.08rem 0.34rem;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-pill);
  color: var(--color-text-tertiary);
  font-size: var(--text-nano);
  font-weight: var(--weight-medium);
}
:global(.status-plugin-menu-separator) {
  height: 0;
  margin: 0.2rem 0;
  border-top: 1px solid var(--color-border-subtle);
}
:global(.status-plugin-menu-item > a),
:global(.status-plugin-menu-item > div) {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 0.12rem 0.65rem;
  align-items: baseline;
  padding: 0.48rem 0.55rem 0.48rem calc(0.55rem + var(--status-menu-indent));
  color: inherit;
  text-decoration: none;
}
:global(.status-plugin-menu-item + .status-plugin-menu-item) {
  border-top: 1px solid var(--color-border-subtle);
}
:global(.status-plugin-menu-item > a:focus-visible) {
  outline: none;
  background: var(--color-surface-hover);
}
@media (hover: hover) {
  :global(.status-plugin-menu-item > a:hover) {
    outline: none;
    background: var(--color-surface-hover);
  }
}
:global(.status-plugin-menu-item__content) {
  display: grid;
  min-width: 0;
  gap: 0.08rem;
}
:global(.status-plugin-menu-item__title) {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 0.32rem;
  color: var(--color-text-secondary);
}
:global(.status-plugin-menu-item__title > span) {
  overflow-wrap: anywhere;
}
:global(.status-plugin-menu-item__title em) {
  padding: 0.08rem 0.32rem;
  border-radius: var(--radius-pill);
  background: var(--color-surface-raised);
  color: var(--color-text-tertiary);
  font-size: var(--text-nano);
  font-style: normal;
}
:global(.status-plugin-menu-item__content small) {
  color: var(--color-text-tertiary);
  font: inherit;
  font-size: var(--text-nano);
}
:global(.status-plugin-menu-item output) {
  color: var(--color-text);
  font: inherit;
  font-weight: var(--weight-strong);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
:global(.status-plugin-menu-item__external) {
  align-self: center;
  color: var(--color-text-tertiary);
}
:global(.status-plugin-menu-item[data-tone="success"] .status-plugin-menu-item__title),
:global(.status-plugin-menu-item[data-tone="success"] output) {
  color: var(--color-success-text);
}
:global(.status-plugin-menu-item[data-tone="warning"] .status-plugin-menu-item__title),
:global(.status-plugin-menu-item[data-tone="warning"] output) {
  color: var(--color-warning-accent);
}
:global(.status-plugin-menu-item[data-tone="danger"] .status-plugin-menu-item__title),
:global(.status-plugin-menu-item[data-tone="danger"] output) {
  color: var(--color-danger-text);
}
:global(.status-plugin-menu-progress) {
  grid-column: 1 / -1;
  height: 0.22rem;
  margin-top: 0.2rem;
  overflow: hidden;
  border-radius: var(--radius-pill);
  background: var(--color-surface-raised);
}
:global(.status-plugin-menu-progress span) {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--color-accent);
}
:global(.status-plugin-error) {
  margin: 0;
  padding: 0.42rem 0.5rem;
  border-radius: var(--radius-sm);
  background: var(--color-danger-surface);
  color: var(--color-danger-text);
  line-height: var(--leading-ui);
}
:global(.status-plugin-times) {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 0.35rem 1rem;
  color: var(--color-text-tertiary);
  font-size: var(--text-nano);
}

@media (max-width: 32rem) {
  :global(.status-plugin) {
    padding-inline: 0.48rem;
  }
  :global(.status-plugin-popover) {
    width: min(22rem, calc(100vw - 1rem));
    min-width: 0;
    max-width: calc(100vw - 1rem);
  }
  .status-plugin-add {
    width: 2.65rem;
  }
}
</style>
