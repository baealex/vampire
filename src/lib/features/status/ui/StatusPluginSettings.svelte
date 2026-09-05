<script lang="ts">
import { onDestroy, onMount, tick } from 'svelte';
import BookOpen from '@lucide/svelte/icons/book-open';
import ChevronDown from '@lucide/svelte/icons/chevron-down';
import ChevronRight from '@lucide/svelte/icons/chevron-right';
import ChevronUp from '@lucide/svelte/icons/chevron-up';
import Ellipsis from '@lucide/svelte/icons/ellipsis';
import Plus from '@lucide/svelte/icons/plus';
import Save from '@lucide/svelte/icons/save';
import Sparkles from '@lucide/svelte/icons/sparkles';
import Trash2 from '@lucide/svelte/icons/trash-2';
import { queryCache, type QuerySnapshot } from '~/lib/shared/api/query-cache';
import { requestJson } from '~/lib/shared/api/request';
import Button from '~/lib/shared/ui/Button.svelte';
import CodeEditor from '~/lib/shared/ui/CodeEditor.svelte';
import DialogEmptyState from '~/lib/shared/ui/DialogEmptyState.svelte';
import DialogToolbar from '~/lib/shared/ui/DialogToolbar.svelte';
import DropdownMenuItem from '~/lib/shared/ui/DropdownMenuItem.svelte';
import DropdownMenuSeparator from '~/lib/shared/ui/DropdownMenuSeparator.svelte';
import DropdownMenuShell from '~/lib/shared/ui/DropdownMenuShell.svelte';
import Input from '~/lib/shared/ui/Input.svelte';
import Select from '~/lib/shared/ui/Select.svelte';
import ManagementSurface from '~/lib/shared/ui/ManagementSurface.svelte';
import AskAgentDialog from '~/lib/shared/ui/AskAgentDialog.svelte';
import { loadWorkspaceAgentAction, submitWorkspaceAgentAction } from '~/lib/shared/api/workspace-agent-actions.ts';
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
} from '~/lib/shared/contracts/status-plugin.ts';
import StatusWidgetGuide from './StatusWidgetGuide.svelte';
import type { ManagedWorkspace } from '~/lib/shared/contracts/workspace.ts';
import { mainWorkspacePromptTarget } from '~/lib/shared/contracts/workspace-agent.ts';

type StatusPluginResponse = { plugins: StatusPlugin[]; presets: StatusPluginPreset[] };
type SettingsView = 'list' | 'detail';
type View = SettingsView | 'guide' | 'agent';
const STATUS_PLUGINS_QUERY = 'status/plugins';
let {
  close,
  workspaceId,
  workspaces = [],
  onBusyChange = () => undefined,
  onDirtyChange = () => undefined,
}: {
  close: () => void;
  workspaceId?: string;
  workspaces?: ManagedWorkspace[];
  onBusyChange?: (busy: boolean) => void;
  onDirtyChange?: (dirty: boolean) => void;
} = $props();
const initialResponse = queryCache.get<StatusPluginResponse>(STATUS_PLUGINS_QUERY);
let plugins = $state<StatusPlugin[]>(initialResponse ? cloneStatusPlugins(initialResponse.plugins) : []);
let presets = $state<StatusPluginPreset[]>(initialResponse?.presets ?? []);
let hasData = $state(initialResponse !== undefined);
let loadedPlugins = $state(initialResponse ? JSON.stringify(initialResponse.plugins) : '[]');
let loading = $state(initialResponse === undefined);
let fetching = $state(false);
let saving = $state(false);
let errorMessage = $state('');
let view = $state<View>('list');
let viewBeforeGuide = $state<SettingsView>('list');
let selectedPluginId = $state<string>();
let selectedTargetWorkspaceId = $state('');
let agentSubmitting = $state(false);
const hasUnsavedChanges = $derived(JSON.stringify(plugins) !== loadedPlugins);
const atCapacity = $derived(plugins.length >= MAX_STATUS_PLUGINS);
const selectedPlugin = $derived(plugins.find((plugin) => plugin.id === selectedPluginId));
const agentTargets = $derived(
  workspaces
    .flatMap((workspace) => {
      const process = mainWorkspacePromptTarget(workspace);
      return process ? [{ workspace, processLabel: process.label }] : [];
    })
    .sort((left, right) => right.workspace.lastActiveAt - left.workspace.lastActiveAt)
);
const selectedFallbackWorkspace = $derived(
  selectedTargetWorkspaceId && !agentTargets.some(({ workspace }) => workspace.id === selectedTargetWorkspaceId)
    ? workspaces.find((workspace) => workspace.id === selectedTargetWorkspaceId)
    : undefined
);

$effect(() => onBusyChange(saving || agentSubmitting));
$effect(() => onDirtyChange(hasUnsavedChanges));

$effect(() => {
  if (agentTargets.some(({ workspace }) => workspace.id === selectedTargetWorkspaceId)) return;
  if (view === 'agent' && selectedTargetWorkspaceId) return;
  const preferred = agentTargets.find(({ workspace }) => workspace.id === workspaceId) ?? agentTargets[0];
  selectedTargetWorkspaceId = preferred?.workspace.id ?? '';
});

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

function openAgentView() {
  if (hasUnsavedChanges) {
    errorMessage = 'Save your widget changes before asking an agent.';
    return;
  }
  const targetWorkspaceId =
    agentTargets.find(({ workspace }) => workspace.id === workspaceId)?.workspace.id ??
    (agentTargets.some(({ workspace }) => workspace.id === selectedTargetWorkspaceId)
      ? selectedTargetWorkspaceId
      : agentTargets[0]?.workspace.id);
  if (!targetWorkspaceId) {
    errorMessage = 'Start a foreground process in a workspace’s main terminal before using Ask agent.';
    return;
  }
  selectedTargetWorkspaceId = targetWorkspaceId;
  errorMessage = '';
  view = 'agent';
}

async function closeAgentView() {
  view = 'list';
  await tick();
  document.getElementById('status-widget-ask-agent-trigger')?.focus();
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
}

let unsubscribe: (() => void) | undefined;

onMount(() => {
  unsubscribe = queryCache.subscribe(STATUS_PLUGINS_QUERY, applyQuerySnapshot);
  void load(true);
});

onDestroy(() => unsubscribe?.());
</script>

<ManagementSurface
  title={view === 'guide'
    ? 'Status widget guide'
    : view === 'detail' && selectedPlugin
      ? selectedPlugin.name || 'New widget'
      : 'Status widgets'}
  titleId="status-widget-settings-title"
  eyebrow="Server settings"
  {close}
  closeLabel="Close status widget settings"
  busy={saving || agentSubmitting}
  showFooter={hasUnsavedChanges && view !== 'guide' && view !== 'agent'}
  back={view === 'agent' ? () => void closeAgentView() : view === 'guide' ? leaveGuide : view === 'detail' ? showPluginList : undefined}
  backLabel={view === 'guide' ? 'Back to status widget settings' : 'Back to status widgets'}
>
  {#snippet children()}
    {#if view === 'guide'}
      <StatusWidgetGuide />
    {:else if view === 'agent'}
      <div class="status-agent-view">
        <label class="status-agent-target">
          <span>Send to</span>
          <Select
            value={selectedTargetWorkspaceId}
            disabled={agentSubmitting || (agentTargets.length === 0 && !selectedFallbackWorkspace)}
            onchange={(event) => selectedTargetWorkspaceId = (event.currentTarget as HTMLSelectElement).value}
          >
            {#if selectedFallbackWorkspace}
              <option value={selectedFallbackWorkspace.id}>
                {selectedFallbackWorkspace.workspaceLabel?.trim() || selectedFallbackWorkspace.cwd}
                · checking process…
              </option>
            {:else if agentTargets.length === 0}
              <option value="">No running foreground process</option>
            {/if}
            {#each agentTargets as target (target.workspace.id)}
              <option value={target.workspace.id}>
                {target.workspace.workspaceLabel?.trim() || target.workspace.cwd}
                · {target.processLabel}
              </option>
            {/each}
          </Select>
          <small>Widget files are global; choose the workspace agent that should update them.</small>
        </label>
        {#if selectedTargetWorkspaceId}
          {#key selectedTargetWorkspaceId}
            <AskAgentDialog
              embedded
              showTarget={false}
              showEmbeddedBack={false}
              close={() => void closeAgentView()}
              load={() => loadWorkspaceAgentAction(selectedTargetWorkspaceId, 'status-widget')}
              submit={(request) => submitWorkspaceAgentAction(selectedTargetWorkspaceId, 'status-widget', request)}
              onSubmittingChange={(value) => agentSubmitting = value}
            />
          {/key}
        {:else}
          <DialogEmptyState
            >Start a foreground process in a workspace’s main terminal to use Ask Agent.</DialogEmptyState
          >
        {/if}
      </div>
    {:else}
      <div class="status-settings" aria-busy={fetching}>
        {#if view === 'list'}
          <DialogToolbar>
            <span>{plugins.length} {plugins.length === 1 ? 'widget' : 'widgets'}</span>
            <div class="status-toolbar-actions">
              <Button variant="secondary" size="sm" onclick={showGuide}>
                <BookOpen size={14} strokeWidth={1.9} aria-hidden="true" />
                <span>Guide</span>
              </Button>
              <Button
                id="status-widget-ask-agent-trigger"
                variant="secondary"
                size="sm"
                onclick={openAgentView}
                disabled={loading || hasUnsavedChanges || agentTargets.length === 0}
                title={hasUnsavedChanges
                  ? 'Save widget changes before using Ask agent.'
                  : agentTargets.length === 0
                    ? 'Start a foreground process in a workspace’s main terminal first.'
                    : undefined}
              >
                <Sparkles size={14} strokeWidth={1.9} aria-hidden="true" />
                <span>Ask agent…</span>
              </Button>
              <DropdownMenuShell
                triggerLabel="Add widget"
                triggerTitle="Add status widget"
                triggerVariant="primary"
                align="end"
              >
                {#snippet trigger()}
                  <Plus size={14} strokeWidth={2} aria-hidden="true" />
                  <span>Add widget</span>
                {/snippet}

                {#snippet children()}
                  {#each presets as preset (preset.id)}
                    <DropdownMenuItem disabled={loading || atCapacity} onSelect={() => addPreset(preset.id)}>
                      <Plus size={14} strokeWidth={2} aria-hidden="true" />
                      <span>{preset.name}</span>
                    </DropdownMenuItem>
                  {/each}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem disabled={loading || atCapacity} onSelect={addCommand}>
                    <Plus size={14} strokeWidth={2} aria-hidden="true" />
                    <span>Command</span>
                  </DropdownMenuItem>
                {/snippet}
              </DropdownMenuShell>
            </div>
          </DialogToolbar>

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
                      <DropdownMenuItem
                        disabled={index === 0}
                        ariaLabel={`Move ${plugin.name || `widget ${index + 1}`} up`}
                        onSelect={() => movePlugin(index, -1)}
                      >
                        <ChevronUp size={15} strokeWidth={1.8} aria-hidden="true" />
                        <span>Move up</span>
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={index === plugins.length - 1}
                        ariaLabel={`Move ${plugin.name || `widget ${index + 1}`} down`}
                        onSelect={() => movePlugin(index, 1)}
                      >
                        <ChevronDown size={15} strokeWidth={1.8} aria-hidden="true" />
                        <span>Move down</span>
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        tone="danger"
                        ariaLabel={`Remove ${plugin.name || `widget ${index + 1}`}`}
                        onSelect={() => removePlugin(plugin.id)}
                      >
                        <Trash2 size={15} strokeWidth={1.8} aria-hidden="true" />
                        <span>Remove</span>
                      </DropdownMenuItem>
                    {/snippet}
                  </DropdownMenuShell>
                </article>
              {/each}
            </div>
          {:else}
            <DialogEmptyState>No status widgets</DialogEmptyState>
          {/if}
          {#if hasUnsavedChanges}
            <p class="status-agent-hint">
              Save changes before asking an agent to update the global widget configuration.
            </p>
          {:else if agentTargets.length === 0}
            <p class="status-agent-hint">Start a foreground process in a workspace’s main terminal to use Ask Agent.</p>
          {/if}
        {:else if selectedPlugin}
          <div class="status-detail">
            <div class="status-plugin-editor status-detail-editor">
              <div class="status-plugin-editor__fields">
                <div class="status-plugin-editor__top">
                  <label class="name-field">
                    <span>Name</span>
                    <Input
                      value={selectedPlugin.name}
                      oninput={(event) => (selectedPlugin.name = (event.currentTarget as HTMLInputElement).value)}
                      maxlength={STATUS_PLUGIN_NAME_MAX_LENGTH}
                    />
                  </label>
                  <label class="interval-field">
                    <span>Every</span>
                    <span class="interval-input">
                      <Input
                        type="number"
                        size="sm"
                        variant="embedded"
                        min={1}
                        max={86400}
                        step={1}
                        value={String(selectedPlugin.intervalMs / 1_000)}
                        oninput={(event) => updateInterval(selectedPlugin, event)}
                      />
                      <em>sec</em>
                    </span>
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
                  <Button
                    variant="danger-outline"
                    size="sm"
                    onclick={() => removePlugin(selectedPlugin.id)}
                    ariaLabel={`Remove ${selectedPlugin.name || 'widget'}`}
                  >
                    <Trash2 size={15} strokeWidth={1.8} aria-hidden="true" />
                    <span>Remove widget</span>
                  </Button>
                </div>
                <div class="command-field">
                  <span>Command</span>
                  <CodeEditor
                    ariaLabel="Command"
                    value={selectedPlugin.source.command}
                    maxlength={STATUS_PLUGIN_COMMAND_MAX_LENGTH}
                    onValueChange={(value) => (selectedPlugin.source.command = value)}
                  />
                </div>
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
    {#if view !== 'guide' && view !== 'agent'}
      <div class="status-settings-footer">
        <span>Unsaved changes</span>
        <Button variant="primary" onclick={() => void save()} disabled={loading || saving || !hasUnsavedChanges}>
          <Save size={15} strokeWidth={1.9} aria-hidden="true" />
          <span>{saving ? 'Saving…' : 'Save changes'}</span>
        </Button>
      </div>
    {/if}
  {/snippet}
</ManagementSurface>

<style>
.status-settings {
  display: grid;
  align-content: start;
  gap: 0.85rem;
  min-width: 0;
}
.status-agent-view {
  display: grid;
  width: 100%;
  gap: 1.25rem;
}
.status-toolbar-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 0.5rem;
}
.status-agent-target {
  display: grid;
  gap: 0.4rem;
}
.status-agent-target > span {
  color: var(--color-text-secondary);
  font-size: var(--text-label);
  font-weight: var(--weight-medium);
}
.status-agent-target small,
.status-agent-hint {
  margin: 0;
  color: var(--color-text-tertiary);
  font-size: var(--text-caption);
  line-height: var(--leading-ui);
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

.status-detail {
  display: grid;
  min-width: 0;
  gap: 0.85rem;
}
.status-detail-editor {
  display: block;
  width: 100%;
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
.command-field {
  display: grid;
  min-width: 0;
  gap: 0.28rem;
  color: var(--color-text-secondary);
  font-size: var(--text-nano);
  font-weight: var(--weight-medium);
}
.interval-input {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  min-width: 0;
  min-height: var(--control-height-md);
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-sm);
  background: var(--color-control-background);
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
  justify-content: space-between;
  gap: 0.45rem;
}
.status-settings-footer > span {
  color: var(--color-text-tertiary);
  font-size: var(--text-caption);
}
@media (max-width: 42rem) {
  .status-detail-editor .status-plugin-editor__top {
    grid-template-columns: minmax(0, 1fr) 6.5rem;
  }
}

@media (max-width: 32rem) {
  .status-settings :global(.toolbar) {
    align-items: stretch;
    flex-direction: column;
  }
  .status-toolbar-actions {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  .status-toolbar-actions :global(button) {
    width: 100%;
  }
  .status-detail-editor .status-plugin-editor__top {
    grid-template-columns: minmax(0, 1fr) 6.2rem;
  }
}
</style>
