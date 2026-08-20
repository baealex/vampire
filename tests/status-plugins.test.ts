import assert from 'node:assert/strict';
import test from 'node:test';
import {
	createStatusPluginPreset,
	defaultStatusPlugins,
	isStatusPluginList,
	STATUS_PLUGIN_CLAUDE_LIMIT_COMMAND,
	STATUS_PLUGIN_CODEX_LIMIT_COMMAND,
	STATUS_PLUGIN_CPU_COMMAND,
	STATUS_PLUGIN_INTERVAL_MAX_MS,
	STATUS_PLUGIN_INTERVAL_MIN_MS,
	STATUS_PLUGIN_MEMORY_COMMAND,
	STATUS_PLUGIN_PRESETS
} from '../src/lib/status/status-plugin.ts';

test('treats CPU and RAM as ordinary default preset instances', () => {
	const plugins = defaultStatusPlugins();

	assert.deepEqual(plugins.map((plugin) => plugin.name), ['CPU', 'RAM']);
	assert.deepEqual(plugins.map((plugin) => plugin.source.command), [
		STATUS_PLUGIN_CPU_COMMAND,
		STATUS_PLUGIN_MEMORY_COMMAND
	]);
	assert.equal(isStatusPluginList(plugins), true);

	plugins[0]!.name = 'Changed locally';
	assert.equal(defaultStatusPlugins()[0]!.name, 'CPU');
});

test('creates a fresh preset instance that users can own and reorder', () => {
	const plugin = createStatusPluginPreset('cpu', 'custom-cpu');

	assert.deepEqual(plugin, {
		id: 'custom-cpu',
		name: 'CPU',
		enabled: true,
		intervalMs: 2_000,
		source: { type: 'command', command: STATUS_PLUGIN_CPU_COMMAND }
	});
	assert.equal(createStatusPluginPreset('missing', 'missing'), undefined);
});

test('offers editable Codex and Claude limit API scripts', () => {
	const codex = createStatusPluginPreset('codex-limit', 'codex-limit');
	const claude = createStatusPluginPreset('claude-limit', 'claude-limit');

	assert.deepEqual([codex?.name, claude?.name], ['Codex Limit', 'Claude Limit']);
	assert.deepEqual([codex?.enabled, claude?.enabled], [true, true]);
	assert.deepEqual([codex?.source.command, claude?.source.command], [
		STATUS_PLUGIN_CODEX_LIMIT_COMMAND,
		STATUS_PLUGIN_CLAUDE_LIMIT_COMMAND
	]);
	assert.equal(isStatusPluginList([codex, claude]), true);
	assert.match(STATUS_PLUGIN_CODEX_LIMIT_COMMAND, /account\/rateLimits\/read/);
	assert.match(STATUS_PLUGIN_CLAUDE_LIMIT_COMMAND, /api\.anthropic\.com\/api\/oauth\/usage/);
	assert.match(STATUS_PLUGIN_CODEX_LIMIT_COMMAND, /progress: Math\.max\(0, Math\.min\(100, window\.usedPercent\)\)/);
	assert.doesNotMatch(STATUS_PLUGIN_CODEX_LIMIT_COMMAND, /\bmenu,\n\tprogress:/);
	assert.match(STATUS_PLUGIN_CODEX_LIMIT_COMMAND, /badge: bucket\.limitId === 'codex' \? 'Overall' : 'Model'/);
	assert.match(STATUS_PLUGIN_CLAUDE_LIMIT_COMMAND, /\{ text: 'Models', badge: 'Model'/);
	assert.ok(STATUS_PLUGIN_PRESETS.every((preset) => preset.command.includes('\n')));
});

test('accepts bounded multiline scripts and rejects unsafe configuration', () => {
	const commandPlugin = {
		id: 'clock',
		name: 'Clock',
		enabled: true,
		intervalMs: 60_000,
		source: { type: 'command' as const, command: "date '+%H:%M'" }
	};

	assert.equal(isStatusPluginList([commandPlugin]), true);
	assert.equal(isStatusPluginList([{ ...commandPlugin, intervalMs: STATUS_PLUGIN_INTERVAL_MIN_MS - 1 }]), false);
	assert.equal(isStatusPluginList([{ ...commandPlugin, intervalMs: STATUS_PLUGIN_INTERVAL_MAX_MS + 1 }]), false);
	assert.equal(isStatusPluginList([{ ...commandPlugin, source: { type: 'command', command: 'echo ok\necho visible' } }]), true);
	assert.equal(isStatusPluginList([{ ...commandPlugin, source: { type: 'command', command: 'echo ok\r\necho invalid' } }]), false);
	assert.equal(isStatusPluginList([{ ...commandPlugin, source: { type: 'command', command: 'echo ok\0' } }]), false);
	assert.equal(isStatusPluginList([{ ...commandPlugin, source: { type: 'system', metric: 'disk' } }]), false);
	assert.equal(isStatusPluginList([commandPlugin, { ...commandPlugin }]), false);
});
