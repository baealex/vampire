<script lang="ts">
	import { onMount } from 'svelte';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ChevronUp from '@lucide/svelte/icons/chevron-up';
	import Plus from '@lucide/svelte/icons/plus';
	import Save from '@lucide/svelte/icons/save';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { requestJson } from '$lib/client/request';
	import DialogShell from '$lib/ui/DialogShell.svelte';
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
		type StatusPluginPreset
	} from './status-plugin.ts';

	let { close }: { close: () => void } = $props();
	let plugins = $state<StatusPlugin[]>([]);
	let presets = $state<StatusPluginPreset[]>([]);
	let loadedPlugins = '[]';
	let loading = $state(true);
	let saving = $state(false);
	let errorMessage = $state('');
	const hasUnsavedChanges = $derived(JSON.stringify(plugins) !== loadedPlugins);
	const atCapacity = $derived(plugins.length >= MAX_STATUS_PLUGINS);

	function newId(prefix: string): string {
		return globalThis.crypto?.randomUUID?.() ?? `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	}

	async function load() {
		loading = true;
		errorMessage = '';
		try {
			const response = await requestJson<{ plugins: StatusPlugin[]; presets: StatusPluginPreset[] }>(
				'/api/status-plugins',
				{ cache: 'no-store' },
				'Unable to load status plugins.'
			);
			plugins = cloneStatusPlugins(response.plugins);
			presets = response.presets;
			loadedPlugins = JSON.stringify(response.plugins);
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Unable to load status plugins.';
		} finally {
			loading = false;
		}
	}

	function addPreset(presetId: string) {
		if (atCapacity) return;
		const plugin = createStatusPluginPreset(presetId, newId(`status-${presetId}`));
		if (plugin) plugins = [...plugins, plugin];
		errorMessage = '';
	}

	function addCommand() {
		if (atCapacity) return;
		plugins = [...plugins, {
			id: newId('status-command'),
			name: 'Command',
			enabled: true,
			intervalMs: 60_000,
			source: { type: 'command', command: '' }
		}];
		errorMessage = '';
	}

	function removePlugin(id: string) {
		plugins = plugins.filter((plugin) => plugin.id !== id);
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
			if (plugin.name.length > STATUS_PLUGIN_NAME_MAX_LENGTH) return `Plugin names must be ${STATUS_PLUGIN_NAME_MAX_LENGTH} characters or fewer.`;
			if (!Number.isInteger(plugin.intervalMs)
				|| plugin.intervalMs < STATUS_PLUGIN_INTERVAL_MIN_MS
				|| plugin.intervalMs > STATUS_PLUGIN_INTERVAL_MAX_MS) {
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
					body: JSON.stringify({ plugins })
				},
				'Unable to save status plugins.'
			);
			plugins = cloneStatusPlugins(response.plugins);
			loadedPlugins = JSON.stringify(response.plugins);
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Unable to save status plugins.';
			return;
		} finally {
			saving = false;
		}
		close();
	}

	onMount(() => void load());
</script>

<DialogShell eyebrow="Server-wide" title="Status plugins" {close} variant="inspect" closeDisabled={saving}>
	{#snippet children()}
		<div class="status-settings">
			<div class="status-settings-intro">
				<div class="status-settings-copy">
					<strong>Build your status bar</strong>
					<p>Scripts run once on the server and their result is shared with every browser. Print one line for the bar, more lines for details, or JSON for richer output.</p>
				</div>
				<div class="status-add-actions" aria-label="Add status plugin">
					{#each presets as preset (preset.id)}
						<button type="button" onclick={() => addPreset(preset.id)} disabled={loading || atCapacity} title={preset.description}>
							<Plus size={14} strokeWidth={2} aria-hidden="true" />
							<span>{preset.name}</span>
						</button>
					{/each}
					<button type="button" onclick={addCommand} disabled={loading || atCapacity}>
						<Plus size={14} strokeWidth={2} aria-hidden="true" />
						<span>Command</span>
					</button>
				</div>
			</div>

			{#if loading}
				<p class="status-loading" role="status">Loading status plugins…</p>
			{:else if plugins.length > 0}
				<div class="status-plugin-editor-list">
					{#each plugins as plugin, index (plugin.id)}
						<article class="status-plugin-editor" class:disabled={!plugin.enabled}>
							<div class="status-plugin-editor__order">
								<span>{index + 1}</span>
								<button type="button" onclick={() => movePlugin(index, -1)} disabled={index === 0} aria-label={`Move ${plugin.name || `plugin ${index + 1}`} up`}>
									<ChevronUp size={15} strokeWidth={1.8} aria-hidden="true" />
								</button>
								<button type="button" onclick={() => movePlugin(index, 1)} disabled={index === plugins.length - 1} aria-label={`Move ${plugin.name || `plugin ${index + 1}`} down`}>
									<ChevronDown size={15} strokeWidth={1.8} aria-hidden="true" />
								</button>
							</div>
							<div class="status-plugin-editor__fields">
								<div class="status-plugin-editor__top">
									<label class="name-field">
										<span>Name</span>
										<input bind:value={plugin.name} maxlength={STATUS_PLUGIN_NAME_MAX_LENGTH} />
									</label>
									<label class="interval-field">
										<span>Every</span>
										<span class="interval-input"><input type="number" min="1" max="86400" step="1" value={plugin.intervalMs / 1_000} oninput={(event) => updateInterval(plugin, event)} /><em>sec</em></span>
									</label>
									<label class="enabled-field">
										<input type="checkbox" bind:checked={plugin.enabled} />
										<span>On</span>
									</label>
									<button class="remove-plugin" type="button" onclick={() => removePlugin(plugin.id)} aria-label={`Remove ${plugin.name || `plugin ${index + 1}`}`}>
										<Trash2 size={15} strokeWidth={1.8} aria-hidden="true" />
									</button>
								</div>
								<label class="command-field">
									<span>Command</span>
									<textarea bind:value={plugin.source.command} maxlength={STATUS_PLUGIN_COMMAND_MAX_LENGTH} spellcheck="false" rows="7" wrap="off"></textarea>
								</label>
							</div>
						</article>
					{/each}
				</div>
			{/if}

			{#if errorMessage}<p class="status-feedback error" role="alert">{errorMessage}</p>{/if}
		</div>
	{/snippet}

	{#snippet footer()}
		<div class="status-settings-footer">
			<p>Commands have the same OS access as the Vampire server user. Output is rendered as text, never HTML.</p>
			<button type="button" onclick={() => void save()} disabled={loading || saving || !hasUnsavedChanges}>
				<Save size={15} strokeWidth={1.9} aria-hidden="true" />
				<span>{saving ? 'Saving…' : hasUnsavedChanges ? 'Save changes' : 'Saved'}</span>
			</button>
		</div>
	{/snippet}
</DialogShell>

<style>
	.status-settings { display: grid; gap: 0.85rem; min-width: 0; }
	.status-settings-intro { display: grid; gap: 0.65rem; }
	.status-settings-copy { min-width: 0; }
	.status-settings-intro strong { display: block; color: var(--color-text); font-size: var(--text-label); font-weight: var(--weight-medium); }
	.status-settings-intro p { max-width: 48rem; margin: 0.22rem 0 0; color: var(--color-text-secondary); font-size: var(--text-caption); line-height: var(--leading-body); }
	.status-add-actions { display: flex; min-width: 0; flex-wrap: wrap; justify-content: flex-start; gap: 0.35rem; }
	.status-add-actions button, .status-settings-footer button { display: inline-flex; align-items: center; justify-content: center; gap: 0.3rem; min-height: 2.25rem; padding: 0 0.58rem; border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: var(--color-control-background); color: var(--color-text); font: inherit; font-size: var(--text-caption); font-weight: var(--weight-medium); cursor: pointer; }
	.status-add-actions button:hover:not(:disabled) { border-color: var(--color-accent); color: var(--color-accent); }
	.status-add-actions button:disabled, .status-settings-footer button:disabled { cursor: default; opacity: 0.5; }
	.status-loading { margin: 0; color: var(--color-text-tertiary); font-size: var(--text-caption); }
	.status-plugin-editor-list { display: grid; gap: 0.55rem; max-height: min(31rem, 54dvh); overflow-y: auto; padding-right: 0.15rem; }
	.status-plugin-editor { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 0.7rem; padding: 0.65rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface-raised); }
	.status-plugin-editor.disabled { opacity: 0.62; }
	.status-plugin-editor__order { display: grid; grid-template-columns: repeat(2, 1.75rem); grid-template-rows: 1.5rem 1.75rem; align-content: start; gap: 0.15rem; }
	.status-plugin-editor__order > span { grid-column: 1 / -1; align-self: center; color: var(--color-text-disabled); font-size: var(--text-nano); text-align: center; }
	.status-plugin-editor__order button, .remove-plugin { display: grid; place-items: center; width: 1.75rem; height: 1.75rem; padding: 0; border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--color-text-tertiary); cursor: pointer; }
	.status-plugin-editor__order button:hover:not(:disabled) { background: var(--color-surface-hover); color: var(--color-text); }
	.status-plugin-editor__order button:disabled { opacity: 0.25; cursor: default; }
	.status-plugin-editor__fields { display: grid; min-width: 0; gap: 0.52rem; }
	.status-plugin-editor__top { display: grid; grid-template-columns: minmax(8rem, 1fr) 7rem auto auto; align-items: end; gap: 0.5rem; }
	.status-plugin-editor label { display: grid; min-width: 0; gap: 0.28rem; color: var(--color-text-secondary); font-size: var(--text-nano); font-weight: var(--weight-medium); }
	.status-plugin-editor input:not([type='checkbox']), .status-plugin-editor textarea { width: 100%; min-width: 0; min-height: 2.2rem; padding: 0 0.55rem; border: 1px solid var(--color-border-strong); border-radius: var(--radius-sm); background: var(--color-control-background); color: var(--color-text); font: inherit; font-size: var(--text-caption); }
	.interval-input { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; min-width: 0; border: 1px solid var(--color-border-strong); border-radius: var(--radius-sm); background: var(--color-control-background); }
	.interval-input input { border: 0 !important; background: transparent !important; }
	.interval-input em { padding-right: 0.48rem; color: var(--color-text-tertiary); font-size: var(--text-nano); font-style: normal; }
	.enabled-field { display: inline-flex !important; align-items: center; gap: 0.32rem !important; min-height: 2.2rem; padding: 0 0.2rem; cursor: pointer; }
	.enabled-field input { accent-color: var(--color-accent); }
	.remove-plugin { align-self: end; width: 2.2rem; height: 2.2rem; }
	.remove-plugin:hover { background: var(--color-danger-surface-hover); color: var(--color-danger-text); }
	.command-field textarea { min-height: 8rem; padding-block: 0.5rem; resize: vertical; font-family: var(--font-mono) !important; line-height: 1.45; tab-size: 2; white-space: pre; overflow: auto; }
	.status-feedback { margin: 0; padding: 0.55rem 0.65rem; border-radius: var(--radius-sm); font-size: var(--text-caption); }
	.status-feedback.error { background: var(--color-danger-surface); color: var(--color-danger-text); }
	.status-settings-footer { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
	.status-settings-footer p { max-width: 34rem; margin: 0; color: var(--color-text-tertiary); font-size: var(--text-nano); line-height: var(--leading-body); }
	.status-settings-footer button { flex: 0 0 auto; border-color: transparent; background: var(--color-accent); color: var(--color-accent-ink); }
	.status-settings-footer button:hover:not(:disabled) { background: var(--color-accent-hover); }

	@media (max-width: 42rem) {
		.status-settings-footer { align-items: stretch; flex-direction: column; }
		.status-settings-footer button { width: 100%; }
		.status-plugin-editor__top { grid-template-columns: minmax(0, 1fr) 6.5rem auto auto; }
	}

	@media (max-width: 32rem) {
		.status-plugin-editor { grid-template-columns: 1fr; }
		.status-plugin-editor__order { display: flex; align-items: center; }
		.status-plugin-editor__order > span { min-width: 1.5rem; }
		.status-plugin-editor__top { grid-template-columns: minmax(0, 1fr) 6.2rem; }
		.enabled-field, .remove-plugin { justify-self: start; }
		.status-plugin-editor-list { max-height: none; }
	}
</style>
