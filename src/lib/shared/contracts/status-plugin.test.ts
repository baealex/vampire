import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
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
  STATUS_PLUGIN_PRESETS,
} from '~/lib/shared/contracts/status-plugin.ts';

const run = promisify(execFile);

function commandProgram(command: string): string {
  const opening = "node --input-type=module <<'VAMPIRE_STATUS'\n";
  const closing = '\nVAMPIRE_STATUS';
  assert.ok(command.startsWith(opening) && command.endsWith(closing));
  return command.slice(opening.length, -closing.length);
}

async function runClaudeLimitPreset(kind: 'session' | 'workspace'): Promise<Record<string, unknown>> {
  const directory = await mkdtemp(join(tmpdir(), 'vampire-claude-limit-'));
  const mockFetch = join(directory, 'mock-fetch.mjs');
  try {
    await writeFile(
      mockFetch,
      `globalThis.fetch = async () => ({
  ok: true,
  json: async () => JSON.parse(process.env.VAMPIRE_CLAUDE_USAGE_PAYLOAD)
});\n`
    );
    const payload = {
      limits: [
        { kind, percent: 21, resets_at: '2026-08-26T10:00:00Z' },
        { kind: 'weekly_all', percent: 34, resets_at: '2026-09-01T10:00:00Z' },
        {
          kind: 'weekly_scoped',
          percent: 13,
          resets_at: '2026-09-01T10:00:00Z',
          scope: { model: { display_name: 'Fable' } },
        },
      ],
    };
    const { stdout } = await run(
      process.execPath,
      ['--input-type=module', '--eval', commandProgram(STATUS_PLUGIN_CLAUDE_LIMIT_COMMAND)],
      {
        env: {
          ...process.env,
          CLAUDE_CODE_OAUTH_TOKEN: 'test-token',
          NODE_OPTIONS: `--import=${mockFetch}`,
          VAMPIRE_CLAUDE_USAGE_PAYLOAD: JSON.stringify(payload),
        },
      }
    );
    return JSON.parse(stdout) as Record<string, unknown>;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('treats CPU and RAM as ordinary default preset instances', () => {
  const plugins = defaultStatusPlugins();

  assert.deepEqual(
    plugins.map((plugin) => plugin.name),
    ['CPU', 'RAM']
  );
  assert.deepEqual(
    plugins.map((plugin) => plugin.source.command),
    [STATUS_PLUGIN_CPU_COMMAND, STATUS_PLUGIN_MEMORY_COMMAND]
  );
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
    source: { type: 'command', command: STATUS_PLUGIN_CPU_COMMAND },
  });
  assert.equal(createStatusPluginPreset('missing', 'missing'), undefined);
});

test('offers editable Codex and Claude limit API scripts', () => {
  const codex = createStatusPluginPreset('codex-limit', 'codex-limit');
  const claude = createStatusPluginPreset('claude-limit', 'claude-limit');

  assert.deepEqual([codex?.name, claude?.name], ['Codex Limit', 'Claude Limit']);
  assert.deepEqual([codex?.enabled, claude?.enabled], [true, true]);
  assert.deepEqual(
    [codex?.source.command, claude?.source.command],
    [STATUS_PLUGIN_CODEX_LIMIT_COMMAND, STATUS_PLUGIN_CLAUDE_LIMIT_COMMAND]
  );
  assert.equal(isStatusPluginList([codex, claude]), true);
  assert.match(STATUS_PLUGIN_CODEX_LIMIT_COMMAND, /account\/rateLimits\/read/);
  assert.match(STATUS_PLUGIN_CLAUDE_LIMIT_COMMAND, /api\.anthropic\.com\/api\/oauth\/usage/);
  assert.match(STATUS_PLUGIN_CODEX_LIMIT_COMMAND, /progress: Math\.max\(0, Math\.min\(100, window\.usedPercent\)\)/);
  assert.doesNotMatch(STATUS_PLUGIN_CODEX_LIMIT_COMMAND, /\bmenu,\n\tprogress:/);
  assert.match(STATUS_PLUGIN_CODEX_LIMIT_COMMAND, /badge: bucket\.limitId === 'codex' \? 'Overall' : 'Model'/);
  assert.match(STATUS_PLUGIN_CLAUDE_LIMIT_COMMAND, /\{ text: 'Models', badge: 'Model'/);
  assert.ok(STATUS_PLUGIN_PRESETS.every((preset) => preset.command.includes('\n')));
});

test('labels current and compatibility Claude session limits as the 5-hour window', async () => {
  for (const kind of ['session', 'workspace'] as const) {
    const output = await runClaudeLimitPreset(kind);
    assert.equal(output.text, '5h 21% · 7d 34%');
    assert.deepEqual(
      (output.menu as Array<{ text?: string; type: string }>)
        .filter((item) => item.type === 'item')
        .map((item) => item.text),
      ['5h', '7d', 'Fable']
    );
  }
});

test('accepts bounded multiline scripts and rejects unsafe configuration', () => {
  const commandPlugin = {
    id: 'clock',
    name: 'Clock',
    enabled: true,
    intervalMs: 60_000,
    source: { type: 'command' as const, command: "date '+%H:%M'" },
  };

  assert.equal(isStatusPluginList([commandPlugin]), true);
  assert.equal(isStatusPluginList([{ ...commandPlugin, intervalMs: STATUS_PLUGIN_INTERVAL_MIN_MS - 1 }]), false);
  assert.equal(isStatusPluginList([{ ...commandPlugin, intervalMs: STATUS_PLUGIN_INTERVAL_MAX_MS + 1 }]), false);
  assert.equal(
    isStatusPluginList([{ ...commandPlugin, source: { type: 'command', command: 'echo ok\necho visible' } }]),
    true
  );
  assert.equal(
    isStatusPluginList([{ ...commandPlugin, source: { type: 'command', command: 'echo ok\r\necho invalid' } }]),
    false
  );
  assert.equal(isStatusPluginList([{ ...commandPlugin, source: { type: 'command', command: 'echo ok\0' } }]), false);
  assert.equal(isStatusPluginList([{ ...commandPlugin, source: { type: 'system', metric: 'disk' } }]), false);
  assert.equal(isStatusPluginList([commandPlugin, { ...commandPlugin }]), false);
});
