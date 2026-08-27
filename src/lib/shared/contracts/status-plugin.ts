export const STATUS_PLUGIN_INTERVAL_MIN_MS = 1_000;
export const STATUS_PLUGIN_INTERVAL_MAX_MS = 24 * 60 * 60 * 1_000;
export const STATUS_PLUGIN_NAME_MAX_LENGTH = 80;
export const STATUS_PLUGIN_COMMAND_MAX_LENGTH = 16_384;
export const STATUS_PLUGIN_ID_MAX_LENGTH = 100;
export const MAX_STATUS_PLUGINS = 24;
export const STATUS_PLUGIN_MENU_MAX_ITEMS = 64;

export type StatusPluginPresetId = 'cpu' | 'memory' | 'codex-limit' | 'claude-limit';
export type StatusPluginTone = 'neutral' | 'success' | 'warning' | 'danger';
export type StatusPluginState = 'loading' | 'ready' | 'stale' | 'error';

export type StatusPluginSource = { type: 'command'; command: string };

export interface StatusPlugin {
  id: string;
  name: string;
  enabled: boolean;
  intervalMs: number;
  source: StatusPluginSource;
}

export interface StatusPluginPreset {
  id: StatusPluginPresetId;
  name: string;
  description: string;
  intervalMs: number;
  command: string;
  defaultEnabled: boolean;
}

export interface StatusPluginMenuTime {
  label?: string;
  at: number;
}

export type StatusPluginMenuEntry =
  | { type: 'heading'; text: string; badge?: string }
  | { type: 'separator' }
  | {
      type: 'item';
      text: string;
      value?: string;
      detail?: string;
      time?: StatusPluginMenuTime;
      badge?: string;
      checked?: boolean;
      progress?: number;
      tone?: StatusPluginTone;
      href?: string;
      indent?: number;
    };

export interface StatusPluginSnapshot {
  id: string;
  name: string;
  state: StatusPluginState;
  text?: string;
  tooltip?: string;
  menu?: StatusPluginMenuEntry[];
  progress?: number;
  tone?: StatusPluginTone;
  updatedAt?: number;
  error?: string;
}

export type StatusPluginOutput = Pick<StatusPluginSnapshot, 'text' | 'tooltip' | 'menu' | 'progress' | 'tone'> & {
  text: string;
};

export const STATUS_PLUGIN_CPU_COMMAND = `node --input-type=module <<'VAMPIRE_STATUS'
import os from 'node:os';

function snapshot() {
	return os.cpus().reduce((total, cpu) => {
		const times = cpu.times;
		total.idle += times.idle;
		total.all += times.user + times.nice + times.sys + times.idle + times.irq;
		return total;
	}, { idle: 0, all: 0 });
}

const before = snapshot();
await new Promise((resolve) => setTimeout(resolve, 100));
const after = snapshot();
const elapsed = after.all - before.all;
const usage = elapsed > 0
	? Math.round((1 - (after.idle - before.idle) / elapsed) * 100)
	: 0;

console.log(JSON.stringify({
	text: '≈' + usage + '%',
	progress: usage,
	menu: [{
		type: 'item',
		text: 'Logical CPU cores',
		value: String(os.cpus().length)
	}]
}));
VAMPIRE_STATUS`;

export const STATUS_PLUGIN_MEMORY_COMMAND = `node --input-type=module <<'VAMPIRE_STATUS'
import os from 'node:os';

const constrained = process.constrainedMemory?.();
const total = constrained && constrained > 0 ? constrained : os.totalmem();
const available = process.availableMemory?.() ?? os.freemem();
const used = Math.max(0, total - Math.min(total, available));
const usage = total > 0 ? Math.round(used / total * 100) : 0;
const gigabytes = (bytes) => (bytes / 2 ** 30).toFixed(1) + ' GB';

console.log(JSON.stringify({
	text: usage + '%',
	progress: usage,
	menu: [{
		type: 'item',
		text: 'Memory used',
		value: gigabytes(used) + ' / ' + gigabytes(total)
	}]
}));
VAMPIRE_STATUS`;

export const STATUS_PLUGIN_CODEX_LIMIT_COMMAND = `node --input-type=module <<'VAMPIRE_STATUS'
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const appServer = spawn(process.env.CODEX_PATH || 'codex', ['app-server'], {
	stdio: ['pipe', 'pipe', 'pipe']
});
const lines = createInterface({ input: appServer.stdout });
let stderr = '';
appServer.stderr.on('data', (chunk) => stderr += chunk);

const result = await new Promise((resolve, reject) => {
	let settled = false;
	const timeout = setTimeout(() => finish(new Error('Codex app-server timed out.')), 7_000);

	function finish(error, value) {
		if (settled) return;
		settled = true;
		clearTimeout(timeout);
		lines.close();
		appServer.kill();
		if (error) reject(error);
		else resolve(value);
	}

	function send(message) {
		appServer.stdin.write(JSON.stringify(message) + '\\n');
	}

	appServer.once('error', (error) => finish(error));
	appServer.once('close', (code) => {
		if (!settled) finish(new Error(stderr.trim() || 'Codex app-server exited with code ' + code + '.'));
	});
	lines.on('line', (line) => {
		let message;
		try {
			message = JSON.parse(line);
		} catch {
			return;
		}
		if (message.id !== 1) return;
		if (message.error) finish(new Error(message.error.message || 'Codex rejected the rate-limit request.'));
		else finish(undefined, message.result);
	});
	appServer.once('spawn', () => {
		send({
			method: 'initialize',
			id: 0,
			params: { clientInfo: { name: 'vampire', title: 'Vampire', version: '0.12.0' } }
		});
		send({ method: 'initialized', params: {} });
		send({ method: 'account/rateLimits/read', id: 1 });
	});
});

function windows(bucket) {
	return [bucket?.primary, bucket?.secondary].filter((window) =>
		window && Number.isFinite(window.usedPercent) && Number.isFinite(window.windowDurationMins)
	);
}

function duration(minutes) {
	if (minutes % 1_440 === 0) return minutes / 1_440 + 'd';
	if (minutes % 60 === 0) return minutes / 60 + 'h';
	return minutes + 'm';
}

function percent(value) {
	return Math.round(value * 10) / 10;
}

const bucketsById = result?.rateLimitsByLimitId;
const buckets = bucketsById && typeof bucketsById === 'object'
	? Object.values(bucketsById)
	: [result?.rateLimits];
const selected = result?.rateLimits || buckets[0];
const selectedWindows = windows(selected).sort((a, b) => a.windowDurationMins - b.windowDurationMins);
if (selectedWindows.length === 0) throw new Error('Codex returned no rate-limit windows.');

const visibleBuckets = buckets
	.filter((bucket) => windows(bucket).length > 0)
	.sort((a, b) => Number(a.limitId !== 'codex') - Number(b.limitId !== 'codex'));
const menu = [];
for (const [index, bucket] of visibleBuckets.entries()) {
	const label = bucket.limitName || (bucket.limitId === 'codex' ? 'Codex' : bucket.limitId);
	if (visibleBuckets.length > 1) {
		menu.push({
			type: 'heading',
			text: label || 'Limit',
			badge: bucket.limitId === 'codex' ? 'Overall' : 'Model'
		});
	}
	for (const window of windows(bucket).sort((a, b) => a.windowDurationMins - b.windowDurationMins)) {
		menu.push({
			type: 'item',
			text: duration(window.windowDurationMins),
			value: percent(window.usedPercent) + '% used',
			progress: Math.max(0, Math.min(100, window.usedPercent)),
			time: Number.isFinite(window.resetsAt)
				? { label: 'Resets', at: window.resetsAt }
				: undefined
		});
	}
	if (index < visibleBuckets.length - 1) menu.push({ type: 'separator' });
}

const highest = Math.max(...selectedWindows.map((window) => window.usedPercent));

console.log(JSON.stringify({
	text: selectedWindows.map((window) =>
		duration(window.windowDurationMins) + ' ' + percent(window.usedPercent) + '%'
	).join(' · '),
	menu,
	tone: highest >= 90 ? 'danger' : highest >= 75 ? 'warning' : 'neutral'
}));
VAMPIRE_STATUS`;

export const STATUS_PLUGIN_CLAUDE_LIMIT_COMMAND = `node --input-type=module <<'VAMPIRE_STATUS'
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Claude's subscription-usage endpoint is not a documented public API.
// This script reads Claude Code's existing login without refreshing or modifying it.
function credentials() {
	if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
		return { accessToken: process.env.CLAUDE_CODE_OAUTH_TOKEN };
	}

	let raw = '';
	if (process.platform === 'darwin') {
		try {
			raw = execFileSync('/usr/bin/security', [
				'find-generic-password', '-s', 'Claude Code-credentials', '-w'
			], { encoding: 'utf8' });
		} catch {
			// Fall through to Claude Code's credentials file.
		}
	}

	if (!raw) {
		const directory = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
		try {
			raw = readFileSync(path.join(directory, '.credentials.json'), 'utf8');
		} catch {
			// Report a single useful error below.
		}
	}

	const stored = raw ? JSON.parse(raw) : {};
	return stored.claudeAiOauth || stored;
}

function percent(value) {
	return Math.round(value * 10) / 10;
}

const login = credentials();
if (!login.accessToken) throw new Error('Claude Code login not found. Sign in with Claude Code first.');

const response = await fetch('https://api.anthropic.com/api/oauth/usage', {
	headers: {
		accept: 'application/json',
		authorization: 'Bearer ' + login.accessToken,
		'anthropic-beta': 'oauth-2025-04-20'
	},
	signal: AbortSignal.timeout(7_000)
});
if (!response.ok) throw new Error('Claude usage request failed with HTTP ' + response.status + '.');
const payload = await response.json();

const rows = (Array.isArray(payload.limits) ? payload.limits : [])
	.map((limit) => {
		const model = limit.scope?.model?.display_name;
		const label = limit.kind === 'session' || limit.kind === 'workspace'
			? '5h'
			: limit.kind === 'weekly_all'
				? '7d'
				: model || limit.kind;
		return {
			label,
			scope: model ? 'model' : 'overall',
			used: Number(limit.percent),
			resetAt: Date.parse(limit.resets_at) / 1_000
		};
	})
	.filter((row) => row.label && Number.isFinite(row.used));
if (rows.length === 0) throw new Error('Claude returned no plan-limit windows.');

const headline = rows.filter((row) => row.label === '5h' || row.label === '7d');
const visible = headline.length > 0 ? headline : rows.slice(0, 2);
const highest = Math.max(...visible.map((row) => row.used));
const groups = [
	{ text: 'Claude', badge: 'Overall', rows: rows.filter((row) => row.scope === 'overall') },
	{ text: 'Models', badge: 'Model', rows: rows.filter((row) => row.scope === 'model') }
].filter((group) => group.rows.length > 0);
const menu = [];
for (const [index, group] of groups.entries()) {
	if (groups.length > 1) menu.push({ type: 'heading', text: group.text, badge: group.badge });
	for (const row of group.rows) {
		menu.push({
			type: 'item',
			text: row.label,
			value: percent(row.used) + '% used',
			progress: Math.max(0, Math.min(100, row.used)),
			time: Number.isFinite(row.resetAt)
				? { label: 'Resets', at: row.resetAt }
				: undefined
		});
	}
	if (index < groups.length - 1) menu.push({ type: 'separator' });
}

console.log(JSON.stringify({
	text: visible.map((row) => row.label + ' ' + percent(row.used) + '%').join(' · '),
	menu,
	tone: highest >= 90 ? 'danger' : highest >= 75 ? 'warning' : 'neutral'
}));
VAMPIRE_STATUS`;

export const STATUS_PLUGIN_PRESETS: readonly StatusPluginPreset[] = [
  {
    id: 'cpu',
    name: 'CPU',
    description: "Sample CPU usage with Vampire's reusable status command.",
    intervalMs: 2_000,
    command: STATUS_PLUGIN_CPU_COMMAND,
    defaultEnabled: true,
  },
  {
    id: 'memory',
    name: 'RAM',
    description: "Read memory usage with Vampire's reusable status command.",
    intervalMs: 2_000,
    command: STATUS_PLUGIN_MEMORY_COMMAND,
    defaultEnabled: true,
  },
  {
    id: 'codex-limit',
    name: 'Codex Limit',
    description: 'Read signed-in Codex limits through the Codex app-server API.',
    intervalMs: 5 * 60_000,
    command: STATUS_PLUGIN_CODEX_LIMIT_COMMAND,
    defaultEnabled: true,
  },
  {
    id: 'claude-limit',
    name: 'Claude Limit',
    description: 'Read signed-in Claude Code plan limits with a cached usage request.',
    intervalMs: 5 * 60_000,
    command: STATUS_PLUGIN_CLAUDE_LIMIT_COMMAND,
    defaultEnabled: true,
  },
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isStatusPluginId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= STATUS_PLUGIN_ID_MAX_LENGTH &&
    /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(value)
  );
}

function isStatusPluginName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= STATUS_PLUGIN_NAME_MAX_LENGTH &&
    value === value.trim() &&
    !/[\0\r\n]/.test(value)
  );
}

function isStatusPluginSource(value: unknown): value is StatusPluginSource {
  if (!isRecord(value)) return false;
  return (
    value.type === 'command' &&
    hasOnlyKeys(value, ['type', 'command']) &&
    typeof value.command === 'string' &&
    value.command.length > 0 &&
    value.command.length <= STATUS_PLUGIN_COMMAND_MAX_LENGTH &&
    value.command === value.command.trim() &&
    !/[\0\r]/.test(value.command)
  );
}

export function isStatusPlugin(value: unknown): value is StatusPlugin {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['id', 'name', 'enabled', 'intervalMs', 'source']) &&
    isStatusPluginId(value.id) &&
    isStatusPluginName(value.name) &&
    typeof value.enabled === 'boolean' &&
    Number.isInteger(value.intervalMs) &&
    Number(value.intervalMs) >= STATUS_PLUGIN_INTERVAL_MIN_MS &&
    Number(value.intervalMs) <= STATUS_PLUGIN_INTERVAL_MAX_MS &&
    isStatusPluginSource(value.source)
  );
}

export function isStatusPluginList(value: unknown): value is StatusPlugin[] {
  if (!Array.isArray(value) || value.length > MAX_STATUS_PLUGINS || !value.every(isStatusPlugin)) return false;
  return new Set(value.map((plugin) => plugin.id)).size === value.length;
}

export function cloneStatusPlugins(plugins: readonly StatusPlugin[]): StatusPlugin[] {
  return plugins.map((plugin) => ({
    ...plugin,
    source: { ...plugin.source },
  }));
}

export function createStatusPluginPreset(presetId: string, id: string): StatusPlugin | undefined {
  const preset = STATUS_PLUGIN_PRESETS.find((candidate) => candidate.id === presetId);
  if (!preset || !isStatusPluginId(id)) return undefined;
  return {
    id,
    name: preset.name,
    enabled: preset.defaultEnabled,
    intervalMs: preset.intervalMs,
    source: { type: 'command', command: preset.command },
  };
}

export function defaultStatusPlugins(): StatusPlugin[] {
  return [createStatusPluginPreset('cpu', 'status-cpu'), createStatusPluginPreset('memory', 'status-memory')].filter(
    (plugin): plugin is StatusPlugin => Boolean(plugin)
  );
}

function isDisplayText(value: unknown, maximum = 1_000): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    value === value.trim() &&
    !/[\0\r\n]/.test(value)
  );
}

function isStatusPluginTone(value: unknown): value is StatusPluginTone {
  return value === 'neutral' || value === 'success' || value === 'warning' || value === 'danger';
}

function isStatusPluginProgress(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

function isStatusPluginMenuTime(value: unknown): value is StatusPluginMenuTime {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['label', 'at']) &&
    (value.label === undefined || isDisplayText(value.label, 80)) &&
    typeof value.at === 'number' &&
    Number.isFinite(value.at) &&
    Number.isFinite(new Date(value.at).getTime())
  );
}

function isSafeStatusHref(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isStatusPluginMenuEntry(value: unknown): value is StatusPluginMenuEntry {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  if (value.type === 'separator') return hasOnlyKeys(value, ['type']);
  if (value.type === 'heading') {
    return (
      hasOnlyKeys(value, ['type', 'text', 'badge']) &&
      isDisplayText(value.text, 240) &&
      (value.badge === undefined || isDisplayText(value.badge, 80))
    );
  }
  return (
    value.type === 'item' &&
    hasOnlyKeys(value, [
      'type',
      'text',
      'value',
      'detail',
      'time',
      'badge',
      'checked',
      'progress',
      'tone',
      'href',
      'indent',
    ]) &&
    isDisplayText(value.text) &&
    (value.value === undefined || isDisplayText(value.value, 240)) &&
    (value.detail === undefined || isDisplayText(value.detail)) &&
    (value.time === undefined || isStatusPluginMenuTime(value.time)) &&
    (value.badge === undefined || isDisplayText(value.badge, 80)) &&
    (value.checked === undefined || typeof value.checked === 'boolean') &&
    (value.progress === undefined || isStatusPluginProgress(value.progress)) &&
    (value.tone === undefined || isStatusPluginTone(value.tone)) &&
    (value.href === undefined || isSafeStatusHref(value.href)) &&
    (value.indent === undefined ||
      (Number.isInteger(value.indent) && Number(value.indent) >= 0 && Number(value.indent) <= 3))
  );
}

function isOptionalStatusPluginMenu(value: unknown): value is StatusPluginMenuEntry[] | undefined {
  return (
    value === undefined ||
    (Array.isArray(value) && value.length <= STATUS_PLUGIN_MENU_MAX_ITEMS && value.every(isStatusPluginMenuEntry))
  );
}

export function isStatusPluginSnapshot(value: unknown): value is StatusPluginSnapshot {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['id', 'name', 'state', 'text', 'tooltip', 'menu', 'progress', 'tone', 'updatedAt', 'error']) &&
    isStatusPluginId(value.id) &&
    isStatusPluginName(value.name) &&
    (value.state === 'loading' || value.state === 'ready' || value.state === 'stale' || value.state === 'error') &&
    (value.text === undefined || isDisplayText(value.text, 240)) &&
    (value.tooltip === undefined || isDisplayText(value.tooltip)) &&
    isOptionalStatusPluginMenu(value.menu) &&
    (value.progress === undefined || isStatusPluginProgress(value.progress)) &&
    (value.tone === undefined || isStatusPluginTone(value.tone)) &&
    (value.updatedAt === undefined || (typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt))) &&
    (value.error === undefined || typeof value.error === 'string')
  );
}

export function isStatusPluginSnapshotList(value: unknown): value is StatusPluginSnapshot[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_STATUS_PLUGINS &&
    value.every(isStatusPluginSnapshot) &&
    new Set(value.map((plugin) => plugin.id)).size === value.length
  );
}
