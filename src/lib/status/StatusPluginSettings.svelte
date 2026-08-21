<script lang="ts">
import { DropdownMenu } from 'bits-ui';
import { onDestroy, onMount } from 'svelte';
import BookOpen from '@lucide/svelte/icons/book-open';
import ChevronDown from '@lucide/svelte/icons/chevron-down';
import ChevronRight from '@lucide/svelte/icons/chevron-right';
import ChevronUp from '@lucide/svelte/icons/chevron-up';
import Ellipsis from '@lucide/svelte/icons/ellipsis';
import Plus from '@lucide/svelte/icons/plus';
import Save from '@lucide/svelte/icons/save';
import Trash2 from '@lucide/svelte/icons/trash-2';
import { queryCache, type QuerySnapshot } from '$lib/client/query-cache';
import { requestJson } from '$lib/client/request';
import DialogShell from '$lib/ui/DialogShell.svelte';
import DropdownMenuShell from '$lib/ui/DropdownMenuShell.svelte';
import {
  cloneStatusPlugins,
  createStatusPluginPreset,
  isStatusPluginList,
  MAX_STATUS_PLUGINS,
  STATUS_PLUGIN_COMMAND_MAX_LENGTH,
  STATUS_PLUGIN_INTERVAL_MAX_MS,
  STATUS_PLUGIN_INTERVAL_MIN_MS,
  STATUS_PLUGIN_NAME_MAX_LENGTH,
  type StatusPlugin,
  type StatusPluginPreset,
} from './status-plugin.ts';
import StatusWidgetGuide from './StatusWidgetGuide.svelte';

type StatusPluginResponse = { plugins: StatusPlugin[]; presets: StatusPluginPreset[] };
type SettingsView = 'list' | 'detail';
type View = SettingsView | 'guide';
const STATUS_PLUGINS_QUERY = 'status/plugins';
let { close }: { close: () => void } = $props();
const initialResponse = queryCache.get<StatusPluginResponse>(STATUS_PLUGINS_QUERY);
let plugins = $state<StatusPlugin[]>(initialResponse ? cloneStatusPlugins(initialResponse.plugins) : []);
let presets = $state<StatusPluginPreset[]>(initialResponse?.presets ?? []);
let hasData = $state(initialResponse !== undefined);
let loadedPlugins = initialResponse ? JSON.stringify(initialResponse.plugins) : '[]';
let loading = $state(initialResponse === undefined);
let fetching = $state(false);
let saving = $state(false);
let errorMessage = $state('');
let view = $state<View>('list');
let viewBeforeGuide = $state<SettingsView>('list');
let selectedPluginId = $state<string>();
const hasUnsavedChanges = $derived(JSON.stringify(plugins) !== loadedPlugins);
const atCapacity = $derived(plugins.length >= MAX_STATUS_PLUGINS);
const selectedPlugin = $derived(plugins.find((plugin) => plugin.id === selectedPluginId));

$effect(() => {
  if (view === 'detail' && !selectedPlugin) {
    view = 'list';
    selectedPluginId = undefined;
  }
});

function newId(prefix: string): string {
  return globalThis.crypto?.randomUUID?.() ?? `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function applyQuerySnapshot(snapshot: QuerySnapshot<StatusPluginResponse>) {
  hasData = snapshot.data !== undefined;
  fetching = snapshot.isFetching;
  loading = !hasData && snapshot.isFetching;
  if (snapshot.data && !hasUnsavedChanges) {
    plugins = cloneStatusPlugins(snapshot.data.plugins);
    presets = snapshot.data.presets;
    loadedPlugins = JSON.stringify(snapshot.data.plugins);
  }
  if (snapshot.error && !hasData) {
    errorMessage = snapshot.error instanceof Error ? snapshot.error.message : 'Unable to load status plugins.';
  } else if (!snapshot.error) {
    errorMessage = '';
  }
}

async function load(force = true) {
  errorMessage = '';
  try {
    await queryCache.fetch(
      STATUS_PLUGINS_QUERY,
      () =>
        requestJson<StatusPluginResponse>(
          '/api/status-plugins',
          { cache: 'no-store' },
          'Unable to load status plugins.'
        ),
      force
    );
  } catch (error) {
    if (!hasData) errorMessage = error instanceof Error ? error.message : 'Unable to load status plugins.';
  }
}

function addPreset(presetId: string) {
  if (atCapacity) return;
  const plugin = createStatusPluginPreset(presetId, newId(`status-${presetId}`));
  if (plugin) {
    plugins = [...plugins, plugin];
    selectedPluginId = plugin.id;
    view = 'detail';
  }
  errorMessage = '';
}

function addCommand() {
  if (atCapacity) return;
  const plugin: StatusPlugin = {
    id: newId('status-command'),
    name: 'Command',
    enabled: true,
    intervalMs: 60_000,
    source: { type: 'command', command: '' },
  };
  plugins = [...plugins, plugin];
  selectedPluginId = plugin.id;
  view = 'detail';
  errorMessage = '';
}

function removePlugin(id: string) {
  plugins = plugins.filter((plugin) => plugin.id !== id);
  if (selectedPluginId === id) {
    selectedPluginId = undefined;
    view = 'list';
  }
}

function openPlugin(id: string) {
  selectedPluginId = id;
  view = 'detail';
  errorMessage = '';
}

function showPluginList() {
  selectedPluginId = undefined;
  view = 'list';
  errorMessage = '';
}

function showGuide() {
  viewBeforeGuide = view === 'detail' ? 'detail' : 'list';
  view = 'guide';
  errorMessage = '';
}

function leaveGuide() {
  view = viewBeforeGuide;
}

function movePlugin(index: number, offset: -1 | 1) {
  const target = index + offset;
  if (target < 0 || target >= plugins.length) return;
  const next = [...plugins];
  [next[index], next[target]] = [next[target]!, next[index]!];
  plugins = next;
}

function updateInterval(plugin: StatusPlugin, event: Event) {
  const seconds = (event.currentTarget as HTMLInputElement).valueAsNumber;
  plugin.intervalMs = Number.isFinite(seconds) ? Math.round(seconds * 1_000) : Number.NaN;
}

function validate(): string | undefined {
  if (plugins.length > MAX_STATUS_PLUGINS) return `Use no more than ${MAX_STATUS_PLUGINS} status plugins.`;
  for (const plugin of plugins) {
    plugin.name = plugin.name.trim();
    if (!plugin.name) return 'Give every status plugin a name.';
    if (plugin.name.length > STATUS_PLUGIN_NAME_MAX_LENGTH)
      return `Plugin names must be ${STATUS_PLUGIN_NAME_MAX_LENGTH} characters or fewer.`;
    if (
      !Number.isInteger(plugin.intervalMs) ||
      plugin.intervalMs < STATUS_PLUGIN_INTERVAL_MIN_MS ||
      plugin.intervalMs > STATUS_PLUGIN_INTERVAL_MAX_MS
    ) {
      return 'Refresh intervals must be whole seconds from 1 to 86,400.';
    }
    plugin.source.command = plugin.source.command.replace(/\r\n?/g, '\n').trim();
    if (!plugin.source.command) return `Give ${plugin.name} a command.`;
    if (plugin.source.command.length > STATUS_PLUGIN_COMMAND_MAX_LENGTH) {
      return `Commands must be ${STATUS_PLUGIN_COMMAND_MAX_LENGTH.toLocaleString('en-US')} characters or fewer.`;
    }
    if (/[\0\r]/.test(plugin.source.command)) return 'Commands contain an unsupported control character.';
  }
  if (!isStatusPluginList(plugins)) return 'One or more status plugins are invalid.';
  return undefined;
}

async function save() {
  errorMessage = validate() ?? '';
  if (errorMessage) return;
  saving = true;
  try {
    const response = await requestJson<{ plugins: StatusPlugin[] }>(
      '/api/status-plugins',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ plugins }),
      },
      'Unable to save status plugins.'
    );
    plugins = cloneStatusPlugins(response.plugins);
    queryCache.set(STATUS_PLUGINS_QUERY, { plugins: response.plugins, presets });
    loadedPlugins = JSON.stringify(response.plugins);
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : 'Unable to save status plugins.';
    return;
  } finally {
    saving = false;
  }
  close();
}

let unsubscribe: (() => void) | undefined;

onMount(() => {
  unsubscribe = queryCache.subscribe(STATUS_PLUGINS_QUERY, applyQuerySnapshot);
  void load(true);
});

onDestroy(() => unsubscribe?.());
</script>

<DialogShell
  title={view === 'guide'
    ? 'Status widget guide'
    : view === 'detail' && selectedPlugin
      ? selectedPlugin.name || 'New widget'
      : 'Status widgets'}
  {close}
  variant="form"
  closeDisabled={saving}
  onBack={view === 'guide' ? leaveGuide : view === 'detail' ? showPluginList : undefined}
  backLabel={view === 'guide' ? 'Back to status widget settings' : 'Back to status widgets'}
  footerVisible={view !== 'guide'}
>
  {#snippet children()}
    {#if view === 'guide'}
      <StatusWidgetGuide />
    {:else}
      <div class="status-settings" aria-busy={fetching}>
        {#if view === 'list'}
          <div class="vampire-dialog-toolbar">
            <span>{plugins.length} {plugins.length === 1 ? 'widget' : 'widgets'}</span>
            <DropdownMenuShell
              triggerLabel="Add widget"
              triggerTitle="Add status widget"
              triggerClass="vampire-dialog-primary-action"
              align="end"
            >
              {#snippet trigger()}
                <Plus size={14} strokeWidth={2} aria-hidden="true" />
                <span>Add widget</span>
              {/snippet}

              {#snippet children()}
                {#each presets as preset (preset.id)}
                  <DropdownMenu.Item
                    class="vampire-menu-item"
                    disabled={loading || atCapacity}
                    onSelect={() => addPreset(preset.id)}
                  >
                    <Plus size={14} strokeWidth={2} aria-hidden="true" />
                    <span>{preset.name}</span>
                  </DropdownMenu.Item>
                {/each}
                <DropdownMenu.Separator class="vampire-menu-separator" />
                <DropdownMenu.Item class="vampire-menu-item" disabled={loading || atCapacity} onSelect={addCommand}>
                  <Plus size={14} strokeWidth={2} aria-hidden="true" />
                  <span>Command</span>
                </DropdownMenu.Item>
              {/snippet}
            </DropdownMenuShell>
          </div>

          {#if loading}
            <p class="status-loading" role="status">Loading status widgets…</p>
          {:else if plugins.length > 0}
            <div class="status-plugin-list">
              {#each plugins as plugin, index (plugin.id)}
                <article class="status-plugin-list-row" class:disabled={!plugin.enabled}>
                  <button
                    type="button"
                    class="status-plugin-list-summary"
                    onclick={() => openPlugin(plugin.id)}
                    aria-label={`Edit ${plugin.name || `widget ${index + 1}`}`}
                  >
                    <span class="status-plugin-list-order">{index + 1}</span>
                    <span class="status-plugin-list-main">
                      <strong>{plugin.name || `Widget ${index + 1}`}</strong>
                      <span>{plugin.intervalMs / 1_000}s · {plugin.enabled ? 'On' : 'Off'}</span>
                    </span>
                    <span class="status-plugin-list-chevron" aria-hidden="true">
                      <ChevronRight size={16} strokeWidth={1.8} />
                    </span>
                  </button>
                  <DropdownMenuShell
                    triggerLabel={`Actions for ${plugin.name || `widget ${index + 1}`}`}
                    triggerTitle="Widget actions"
                    triggerClass="status-row-menu-trigger"
                    align="end"
                  >
                    {#snippet trigger()}
                      <Ellipsis size={17} strokeWidth={1.9} aria-hidden="true" />
                    {/snippet}

                    {#snippet children()}
                      <DropdownMenu.Item
                        class="vampire-menu-item"
                        disabled={index === 0}
                        aria-label={`Move ${plugin.name || `widget ${index + 1}`} up`}
                        onSelect={() => movePlugin(index, -1)}
                      >
                        <ChevronUp size={15} strokeWidth={1.8} aria-hidden="true" />
                        <span>Move up</span>
                      </DropdownMenu.Item>
                      <DropdownMenu.Item
                        class="vampire-menu-item"
                        disabled={index === plugins.length - 1}
                        aria-label={`Move ${plugin.name || `widget ${index + 1}`} down`}
                        onSelect={() => movePlugin(index, 1)}
                      >
                        <ChevronDown size={15} strokeWidth={1.8} aria-hidden="true" />
                        <span>Move down</span>
                      </DropdownMenu.Item>
                      <DropdownMenu.Separator class="vampire-menu-separator" />
                      <DropdownMenu.Item
                        class="vampire-menu-item danger"
                        aria-label={`Remove ${plugin.name || `widget ${index + 1}`}`}
                        onSelect={() => removePlugin(plugin.id)}
                      >
                        <Trash2 size={15} strokeWidth={1.8} aria-hidden="true" />
                        <span>Remove</span>
                      </DropdownMenu.Item>
                    {/snippet}
                  </DropdownMenuShell>
                </article>
              {/each}
            </div>
          {:else}
            <p class="vampire-dialog-empty-state">No status widgets</p>
          {/if}
        {:else if selectedPlugin}
          <div class="status-detail">
            <div class="status-plugin-editor status-detail-editor">
              <div class="status-plugin-editor__fields">
                <div class="status-plugin-editor__top">
                  <label class="name-field">
                    <span>Name</span>
                    <input
                      value={selectedPlugin.name}
                      oninput={(event) => (selectedPlugin.name = (event.currentTarget as HTMLInputElement).value)}
                      maxlength={STATUS_PLUGIN_NAME_MAX_LENGTH}
                    >
                  </label>
                  <label class="interval-field">
                    <span>Every</span>
                    <span class="interval-input"
                      ><input
                        type="number"
                        min="1"
                        max="86400"
                        step="1"
                        value={selectedPlugin.intervalMs / 1_000}
                        oninput={(event) => updateInterval(selectedPlugin, event)}
                      ><em>sec</em></span
                    >
                  </label>
                </div>
                <div class="status-plugin-editor__options">
                  <label class="enabled-field">
                    <input
                      type="checkbox"
                      checked={selectedPlugin.enabled}
                      onchange={(event) => (selectedPlugin.enabled = (event.currentTarget as HTMLInputElement).checked)}
                    >
                    <span>Enabled</span>
                  </label>
                  <button
                    class="remove-plugin"
                    type="button"
                    onclick={() => removePlugin(selectedPlugin.id)}
                    aria-label={`Remove ${selectedPlugin.name || 'widget'}`}
                  >
                    <Trash2 size={15} strokeWidth={1.8} aria-hidden="true" />
                    <span>Remove widget</span>
                  </button>
                </div>
                <label class="command-field">
                  <span>Command</span>
                  <textarea
                    value={selectedPlugin.source.command}
                    oninput={(event) => (selectedPlugin.source.command = (event.currentTarget as HTMLTextAreaElement).value)}
                    maxlength={STATUS_PLUGIN_COMMAND_MAX_LENGTH}
                    spellcheck="false"
                    rows="7"
                    wrap="off"
                  ></textarea>
                </label>
              </div>
            </div>
          </div>
        {/if}

        {#if errorMessage}
          <p class="status-feedback error" role="alert">{errorMessage}</p>
        {/if}
      </div>
    {/if}
  {/snippet}

  {#snippet footer()}
    <div class="status-settings-footer">
      <button class="vampire-dialog-secondary-button" type="button" onclick={showGuide}>
        <BookOpen size={15} strokeWidth={1.9} aria-hidden="true" />
        <span>Guide</span>
      </button>
      <button
        class="vampire-dialog-primary-button"
        type="button"
        onclick={() => void save()}
        disabled={loading || saving || !hasUnsavedChanges}
      >
        <Save size={15} strokeWidth={1.9} aria-hidden="true" />
        <span>{saving ? 'Saving…' : 'Save changes'}</span>
      </button>
    </div>
  {/snippet}
</DialogShell>

<style>
.status-settings {
  display: grid;
  align-content: start;
  gap: 0.85rem;
  min-width: 0;
}
.status-loading {
  margin: 0;
  color: var(--color-text-tertiary);
  font-size: var(--text-caption);
}
.status-plugin-list {
  display: grid;
  gap: 0.55rem;
  overflow: visible;
}
.status-plugin-list-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-control);
  background: var(--color-surface-raised);
}
.status-plugin-list-row.disabled {
  opacity: 0.62;
}
.status-plugin-list-summary {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.65rem;
  min-width: 0;
  min-height: 3.2rem;
  padding: 0.55rem 0.7rem;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
@media (hover: hover) {
  .status-plugin-list-summary:hover {
    background: var(--color-surface-hover);
  }
}
.status-plugin-list-order {
  display: grid;
  place-items: center;
  width: 1.5rem;
  height: 1.5rem;
  border-radius: var(--radius-sm);
  color: var(--color-text-disabled);
  font-size: var(--text-nano);
  text-align: center;
}
.status-plugin-list-main {
  display: grid;
  min-width: 0;
  gap: 0.2rem;
}
.status-plugin-list-main strong {
  overflow: hidden;
  color: var(--color-text);
  font-size: var(--text-label);
  font-weight: var(--weight-medium);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.status-plugin-list-main span {
  color: var(--color-text-tertiary);
  font-size: var(--text-nano);
}
.status-plugin-list-chevron {
  display: grid;
  place-items: center;
  color: var(--color-text-disabled);
}

:global(.status-row-menu-trigger) {
  display: grid;
  place-items: center;
  width: 2.75rem;
  min-height: 3.2rem;
  padding: 0;
  border: 0;
  border-left: 1px solid var(--color-border-subtle);
  background: transparent;
  color: var(--color-text-tertiary);
  cursor: pointer;
}

:global(.status-row-menu-trigger[data-state="open"]) {
  background: var(--color-surface-hover);
  color: var(--color-text);
}

@media (hover: hover) {
  :global(.status-row-menu-trigger:hover) {
    background: var(--color-surface-hover);
    color: var(--color-text);
  }
}

.remove-plugin {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.35rem;
  height: 2.2rem;
  padding: 0 0.5rem;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-tertiary);
  font: inherit;
  font-size: var(--text-caption);
  font-weight: var(--weight-medium);
  cursor: pointer;
}
.status-detail {
  display: grid;
  min-width: 0;
  gap: 0.85rem;
}
.status-detail-editor {
  display: block;
  width: min(100%, 36rem);
  margin: 0 auto;
  padding: 0.15rem 0;
}
.status-plugin-editor__fields {
  display: grid;
  min-width: 0;
  gap: 0.52rem;
}
.status-plugin-editor__top {
  display: grid;
  grid-template-columns: minmax(8rem, 1fr) 7rem;
  align-items: end;
  gap: 0.5rem;
}
.status-plugin-editor__options {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  min-height: 2.2rem;
}
.status-plugin-editor label {
  display: grid;
  min-width: 0;
  gap: 0.28rem;
  color: var(--color-text-secondary);
  font-size: var(--text-nano);
  font-weight: var(--weight-medium);
}
.status-plugin-editor input:not([type="checkbox"]),
.status-plugin-editor textarea {
  width: 100%;
  min-width: 0;
  min-height: 2.2rem;
  padding: 0 0.55rem;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-sm);
  background: var(--color-control-background);
  color: var(--color-text);
  font: inherit;
  font-size: var(--text-caption);
}
.interval-input {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  min-width: 0;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-sm);
  background: var(--color-control-background);
}
.interval-input input {
  border: 0 !important;
  background: transparent !important;
}
.interval-input em {
  padding-right: 0.48rem;
  color: var(--color-text-tertiary);
  font-size: var(--text-nano);
  font-style: normal;
}
.enabled-field {
  display: inline-flex !important;
  align-items: center;
  gap: 0.32rem !important;
  min-height: 2.2rem;
  padding: 0 0.2rem;
  cursor: pointer;
}
.enabled-field input {
  accent-color: var(--color-accent);
}
@media (hover: hover) {
  .remove-plugin:hover {
    background: var(--color-danger-surface-hover);
    color: var(--color-danger-text);
  }
}
.command-field textarea {
  min-height: 12rem;
  padding-block: 0.5rem;
  resize: vertical;
  font-family: var(--font-mono) !important;
  line-height: 1.45;
  tab-size: 2;
  white-space: pre;
  overflow: auto;
}
.status-feedback {
  margin: 0;
  padding: 0.55rem 0.65rem;
  border-radius: var(--radius-sm);
  font-size: var(--text-caption);
}
.status-feedback.error {
  background: var(--color-danger-surface);
  color: var(--color-danger-text);
}
.status-settings-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 0.45rem;
}
@media (max-width: 42rem) {
  .status-detail-editor .status-plugin-editor__top {
    grid-template-columns: minmax(0, 1fr) 6.5rem;
  }
}

@media (max-width: 32rem) {
  .status-detail-editor .status-plugin-editor__top {
    grid-template-columns: minmax(0, 1fr) 6.2rem;
  }
}
</style>
