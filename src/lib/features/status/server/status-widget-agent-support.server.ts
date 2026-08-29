import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  MAX_STATUS_PLUGINS,
  STATUS_PLUGIN_COMMAND_MAX_LENGTH,
  STATUS_PLUGIN_ID_MAX_LENGTH,
  STATUS_PLUGIN_INTERVAL_MAX_MS,
  STATUS_PLUGIN_INTERVAL_MIN_MS,
  STATUS_PLUGIN_NAME_MAX_LENGTH,
} from '~/lib/shared/contracts/status-plugin.ts';
import { errorHasCode } from '~/lib/server/path-policy.ts';
import { vampireStateDirectory } from '~/lib/server/state-path.ts';
import {
  ensureStatusPluginStoreFile,
  STATUS_PLUGIN_STATE_VERSION,
  statusPluginStatePath,
} from './status-plugin-store.server.ts';

const GUIDE_DIRECTORY_NAME = 'agent-guides';
const GUIDE_FILE_NAME = 'status-widget.md';
const VALIDATOR_FILE_NAME = 'validate-status-widgets.mjs';

function statusWidgetGuide(): string {
  return `# Vampire status widget agent guide

The configuration file is a JSON object with this shape:

\`\`\`ts
type StatusWidgetStore = {
  version: ${STATUS_PLUGIN_STATE_VERSION};
  plugins: Array<{
    id: string;
    name: string;
    enabled: boolean;
    intervalMs: number;
    source: { type: 'command'; command: string };
  }>;
};
\`\`\`

Read the existing file and preserve unrelated widgets. Add or update only the widget requested by the user.

- Use a stable unique id with at most ${STATUS_PLUGIN_ID_MAX_LENGTH} characters.
- Keep the name at ${STATUS_PLUGIN_NAME_MAX_LENGTH} characters or fewer.
- Use an integer refresh interval from ${STATUS_PLUGIN_INTERVAL_MIN_MS} to ${STATUS_PLUGIN_INTERVAL_MAX_MS} milliseconds.
- The command may contain a shell script or a quoted heredoc and must stay within ${STATUS_PLUGIN_COMMAND_MAX_LENGTH} characters.
- A configuration may contain at most ${MAX_STATUS_PLUGINS} widgets.
- Commands run on the Vampire server with the server user's OS permissions, a 10-second timeout, and a 32 KB output limit.

The command must print either a compact plain-text status or one JSON object. Structured output requires \`text\` and supports:

\`\`\`ts
type StatusWidgetOutput = {
  text: string;
  tooltip?: string;
  tone?: 'neutral' | 'success' | 'warning' | 'danger';
  progress?: number; // 0..100
  menu?: Array<
    | { type: 'heading'; text: string; badge?: string }
    | { type: 'separator' }
    | {
        type: 'item';
        text: string;
        value?: string;
        detail?: string;
        badge?: string;
        checked?: boolean;
        progress?: number;
        tone?: 'neutral' | 'success' | 'warning' | 'danger';
        indent?: number; // 0..3
        href?: string; // http or https
        time?: { label?: string; at: string | number };
      }
  >;
};
\`\`\`

Example command:

\`\`\`sh
node --input-type=module <<'VAMPIRE_STATUS'
console.log(JSON.stringify({ text: 'API online', tone: 'success' }));
VAMPIRE_STATUS
\`\`\`

Run the validator command supplied by Vampire after editing the configuration. A valid file is detected automatically by the running server; do not restart Vampire.
`;
}

function statusWidgetValidator(): string {
  return `#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const file = process.argv[2];
if (!file) throw new Error('Provide the status widget configuration path.');
const state = JSON.parse(await readFile(file, 'utf8'));
const fail = (message) => { throw new Error(message); };
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;
if (!state || typeof state !== 'object' || Array.isArray(state) || state.version !== ${STATUS_PLUGIN_STATE_VERSION}) {
  fail('Expected a version ${STATUS_PLUGIN_STATE_VERSION} status widget store.');
}
if (!Array.isArray(state.plugins) || state.plugins.length > ${MAX_STATUS_PLUGINS}) {
  fail('plugins must be an array with at most ${MAX_STATUS_PLUGINS} entries.');
}
const ids = new Set();
for (const [index, plugin] of state.plugins.entries()) {
  const label = 'plugins[' + index + ']';
  if (!plugin || typeof plugin !== 'object' || Array.isArray(plugin)) fail(label + ' must be an object.');
  if (!text(plugin.id, ${STATUS_PLUGIN_ID_MAX_LENGTH}) || ids.has(plugin.id)) fail(label + '.id must be unique and bounded.');
  ids.add(plugin.id);
  if (!text(plugin.name, ${STATUS_PLUGIN_NAME_MAX_LENGTH})) fail(label + '.name is invalid.');
  if (typeof plugin.enabled !== 'boolean') fail(label + '.enabled must be boolean.');
  if (!Number.isInteger(plugin.intervalMs) || plugin.intervalMs < ${STATUS_PLUGIN_INTERVAL_MIN_MS} || plugin.intervalMs > ${STATUS_PLUGIN_INTERVAL_MAX_MS}) {
    fail(label + '.intervalMs is outside the supported range.');
  }
  const source = plugin.source;
  if (!source || source.type !== 'command' || !text(source.command, ${STATUS_PLUGIN_COMMAND_MAX_LENGTH}) || /[\\0\\r]/.test(source.command)) {
    fail(label + '.source must contain one valid command.');
  }
}
console.log('Valid Vampire status widget configuration (' + state.plugins.length + ' widgets).');
`;
}

async function writeManagedSupportFile(path: string, content: string, mode: number): Promise<void> {
  try {
    const details = await lstat(path);
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new Error(`Vampire agent support path is not a regular file: ${path}`);
    }
    if ((await readFile(path, 'utf8')) === content) {
      await chmod(path, mode);
      return;
    }
  } catch (error) {
    if (!errorHasCode(error, 'ENOENT')) throw error;
  }

  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, content, { encoding: 'utf8', mode, flag: 'wx' });
  await rename(temporaryPath, path);
  await chmod(path, mode);
}

function shellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export type StatusWidgetAgentSupport = {
  configurationPath: string;
  guidePath: string;
  validatorPath: string;
  validationCommand: string;
};

export async function ensureStatusWidgetAgentSupport(): Promise<StatusWidgetAgentSupport> {
  const configurationPath = await ensureStatusPluginStoreFile(statusPluginStatePath());
  const guideDirectory = join(vampireStateDirectory(), GUIDE_DIRECTORY_NAME);
  const guidePath = join(guideDirectory, GUIDE_FILE_NAME);
  const validatorPath = join(guideDirectory, VALIDATOR_FILE_NAME);
  await mkdir(guideDirectory, { recursive: true, mode: 0o700 });
  await chmod(guideDirectory, 0o700);
  await Promise.all([
    writeManagedSupportFile(guidePath, statusWidgetGuide(), 0o600),
    writeManagedSupportFile(validatorPath, statusWidgetValidator(), 0o700),
  ]);
  return {
    configurationPath,
    guidePath,
    validatorPath,
    validationCommand: `node ${shellArgument(validatorPath)} ${shellArgument(configurationPath)}`,
  };
}
