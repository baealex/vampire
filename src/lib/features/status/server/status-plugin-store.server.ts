import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  cloneStatusPlugins,
  defaultStatusPlugins,
  isStatusPluginList,
  STATUS_PLUGIN_CLAUDE_LIMIT_COMMAND,
  STATUS_PLUGIN_CODEX_LIMIT_COMMAND,
  STATUS_PLUGIN_CPU_COMMAND,
  STATUS_PLUGIN_MEMORY_COMMAND,
  type StatusPlugin,
} from '~/lib/shared/contracts/status-plugin.ts';
import { errorHasCode } from '~/lib/server/path-policy.ts';
import { vampireStateDirectory } from '~/lib/server/state-path.ts';

export const STATUS_PLUGIN_STATE_VERSION = 1;

export interface StatusPluginStore {
  version: typeof STATUS_PLUGIN_STATE_VERSION;
  plugins: StatusPlugin[];
}

let mutationQueue: Promise<void> = Promise.resolve();

const COMPATIBILITY_STATUS_PLUGIN_CPU_COMMAND = [
  `node -e "const o=require('node:os'),s=()=>o.cpus().reduce((r,c)=>{const t=c.times;r.idle+=t.idle;r.total+=t.user+t.nice+t.sys+t.idle+t.irq;return r},{idle:0,total:0}),a=s();`,
  `setTimeout(()=>{const b=s(),d=b.total-a.total,p=d>0?Math.max(0,Math.min(100,Math.round((1-(b.idle-a.idle)/d)*100))):0;`,
  `console.log(JSON.stringify({text:'≈'+p+'%',progress:p,detail:['Sampled across all logical CPU cores.']}))},100)"`,
].join('');

const COMPATIBILITY_STATUS_PLUGIN_MEMORY_COMMAND = [
  `node -e "const o=require('node:os'),t=process.constrainedMemory?.()||o.totalmem(),a=process.availableMemory?.()||o.freemem(),`,
  `u=Math.max(0,t-Math.min(t,a)),p=t?Math.round(u/t*100):0,g=n=>(n/2**30).toFixed(1)+' GB';`,
  `console.log(JSON.stringify({text:p+'%',progress:p,detail:[g(u)+' of '+g(t)+' used.']}))"`,
].join('');

// Upgrade only exact bundled scripts; a user-edited command must remain untouched.
const REPLACED_BUNDLED_COMMANDS = new Map([
  ['8fb3a6b0e57480a197e831ffa4af975c801b38f427585c1cdf8b2c2587680f80', STATUS_PLUGIN_CPU_COMMAND],
  ['9058df3fb0be94c02847776bf6242af3e8b22b4c7057fa5ad6629416fdb3a703', STATUS_PLUGIN_MEMORY_COMMAND],
  ['050caea08db1269a77c1e438ee7ea2afefec3ad90dc44f47cf4c5009e938026d', STATUS_PLUGIN_CODEX_LIMIT_COMMAND],
  ['55bba15599e62d855a988c4360f893b40ca26544d731a047292d35ea60305ce7', STATUS_PLUGIN_CODEX_LIMIT_COMMAND],
  ['badf1d96abb344cb09af9e55ef6e846b929df47437482d04cc4dcb3eb09dbfe2', STATUS_PLUGIN_CODEX_LIMIT_COMMAND],
  ['66794c7199039d93a6cc7f14870b5fdfaf27e19322f0b291b626227143bf3c58', STATUS_PLUGIN_CLAUDE_LIMIT_COMMAND],
  ['fc7a4f4ba495e5b6810f2ac6c69be29cd9943cde88d3d2a9421e37fe79266ab8', STATUS_PLUGIN_CLAUDE_LIMIT_COMMAND],
]);

function replacedBundledCommand(command: string): string | undefined {
  const digest = createHash('sha256').update(command).digest('hex');
  return REPLACED_BUNDLED_COMMANDS.get(digest);
}

function migrateStatusPlugins(value: unknown): StatusPlugin[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const migrated = value.map((plugin): unknown => {
    if (!plugin || typeof plugin !== 'object' || Array.isArray(plugin)) return plugin;
    const source = (plugin as Record<string, unknown>).source;
    if (!source || typeof source !== 'object' || Array.isArray(source)) return plugin;
    const fields = source as Record<string, unknown>;
    let command: string | undefined;
    if (fields.type === 'system' && Object.keys(fields).length === 2 && Object.hasOwn(fields, 'metric')) {
      command =
        fields.metric === 'cpu'
          ? STATUS_PLUGIN_CPU_COMMAND
          : fields.metric === 'memory'
            ? STATUS_PLUGIN_MEMORY_COMMAND
            : undefined;
    } else if (fields.type === 'command' && typeof fields.command === 'string') {
      command =
        fields.command === COMPATIBILITY_STATUS_PLUGIN_CPU_COMMAND
          ? STATUS_PLUGIN_CPU_COMMAND
          : fields.command === COMPATIBILITY_STATUS_PLUGIN_MEMORY_COMMAND
            ? STATUS_PLUGIN_MEMORY_COMMAND
            : replacedBundledCommand(fields.command);
    }
    if (!command) return plugin;
    return {
      ...plugin,
      source: { type: 'command', command },
    };
  });
  return isStatusPluginList(migrated) ? migrated : undefined;
}

export function statusPluginStatePath(): string {
  return join(vampireStateDirectory(), 'status-plugins.json');
}

function parseStatusPluginStore(value: unknown): StatusPluginStore {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid status plugin state');
  const state = value as Record<string, unknown>;
  if (state.version !== STATUS_PLUGIN_STATE_VERSION) {
    throw new Error('invalid status plugin state');
  }
  const plugins = migrateStatusPlugins(state.plugins);
  if (!plugins) throw new Error('invalid status plugin state');
  return {
    version: STATUS_PLUGIN_STATE_VERSION,
    plugins: cloneStatusPlugins(plugins),
  };
}

export async function readStatusPluginStore(file = statusPluginStatePath()): Promise<StatusPluginStore> {
  try {
    return parseStatusPluginStore(JSON.parse(await readFile(file, 'utf8')) as unknown);
  } catch (error) {
    if (errorHasCode(error, 'ENOENT')) {
      return { version: STATUS_PLUGIN_STATE_VERSION, plugins: defaultStatusPlugins() };
    }
    throw new Error('Vampire status plugin configuration is unreadable; refusing to overwrite it.', { cause: error });
  }
}

export async function writeStatusPluginStore(state: StatusPluginStore, file = statusPluginStatePath()): Promise<void> {
  const parsed = parseStatusPluginStore(state);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporaryFile = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporaryFile, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporaryFile, file);
}

async function materializeStatusPluginStoreFile(file: string): Promise<string> {
  try {
    const details = await lstat(file);
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new Error('Vampire status plugin configuration is not a regular file.');
    }
    await readStatusPluginStore(file);
    return file;
  } catch (error) {
    if (!errorHasCode(error, 'ENOENT')) throw error;
  }

  await writeStatusPluginStore(await readStatusPluginStore(file), file);
  return file;
}

export async function ensureStatusPluginStoreFile(file = statusPluginStatePath()): Promise<string> {
  const operation = mutationQueue.then(() => materializeStatusPluginStoreFile(file));
  mutationQueue = operation.then(
    () => undefined,
    () => undefined
  );
  return operation;
}

export async function replaceStatusPlugins(
  plugins: StatusPlugin[],
  file = statusPluginStatePath()
): Promise<StatusPluginStore> {
  if (!isStatusPluginList(plugins)) throw new TypeError('Invalid status plugin configuration.');
  const operation = mutationQueue.then(async () => {
    await readStatusPluginStore(file);
    await writeStatusPluginStore(
      {
        version: STATUS_PLUGIN_STATE_VERSION,
        plugins: cloneStatusPlugins(plugins),
      },
      file
    );
  });
  mutationQueue = operation.catch(() => undefined);
  await operation;
  return {
    version: STATUS_PLUGIN_STATE_VERSION,
    plugins: cloneStatusPlugins(plugins),
  };
}
