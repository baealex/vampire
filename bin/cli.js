import { readFile } from 'node:fs/promises';
import { delimiter, resolve } from 'node:path';
import { parseArgs, parseEnv } from 'node:util';

const HELP = `Usage: vampire [options]

Run the Vampire workspace server.

Options:
  -h, --help                     Show this help
  -v, --version                  Show the installed version
      --host <address>           Bind address (default: 127.0.0.1)
      --port <number>            Listen port (default: 7677)
      --origin <url>             Public http(s) origin behind a reverse proxy
      --workspace-root <path>    Allowed workspace root; repeat for more roots
      --state-dir <path>         Persistent state directory (default: ~/.vampire)
      --env-file <path>          Load an explicit environment file
      --token-file <path>        Read the VAMPIRE_TOKEN login secret from a file
      --allow-insecure-no-auth   Allow external access without authentication (unsafe)

Precedence: CLI options > process environment > --env-file > defaults.
Authentication is optional for loopback access and required for external access by default.
Use VAMPIRE_TOKEN or --token-file for login; the secret is never accepted on the command line.
`;

function cliArguments(args) {
  return parseArgs({
    args,
    allowPositionals: false,
    strict: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      host: { type: 'string' },
      port: { type: 'string' },
      origin: { type: 'string' },
      'workspace-root': { type: 'string', multiple: true },
      'state-dir': { type: 'string' },
      'env-file': { type: 'string' },
      'token-file': { type: 'string' },
      'allow-insecure-no-auth': { type: 'boolean' },
    },
  }).values;
}

async function packageVersion() {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  return manifest.version;
}

async function loadEnvironmentFile(path, env) {
  const values = parseEnv(await readFile(path, 'utf8'));
  for (const [name, value] of Object.entries(values)) {
    if (env[name] === undefined) env[name] = value;
  }
}

function applyCliEnvironment(values, env) {
  if (values.host !== undefined) env.VAMPIRE_HOST = values.host;
  if (values.port !== undefined) env.VAMPIRE_PORT = values.port;
  if (values.origin !== undefined) {
    env.VAMPIRE_PUBLIC_ORIGIN = values.origin;
    env.VAMPIRE_ADAPTER_ORIGIN = values.origin;
  }
  if (values['workspace-root'] !== undefined) {
    env.VAMPIRE_WORKSPACE_ROOTS = values['workspace-root'].join(delimiter);
  }
  if (values['state-dir'] !== undefined) env.VAMPIRE_STATE_DIR = values['state-dir'];
  if (values['allow-insecure-no-auth']) env.VAMPIRE_ALLOW_INSECURE_NO_AUTH = '1';
}

export async function runCli({
  args = process.argv.slice(2),
  cwd = process.cwd(),
  env = process.env,
  write = (message) => process.stdout.write(message),
  importServer = () => import('../build/vampire-server.js'),
} = {}) {
  const values = cliArguments(args);
  if (values.help) {
    write(HELP);
    return;
  }
  if (values.version) {
    write(`vampire ${await packageVersion()}\n`);
    return;
  }

  if (values['env-file']) {
    await loadEnvironmentFile(resolve(cwd, values['env-file']), env);
  }
  applyCliEnvironment(values, env);

  if (values['token-file']) {
    const token = (await readFile(resolve(cwd, values['token-file']), 'utf8')).replace(/\r?\n$/, '');
    if (!token.trim()) throw new Error('The token file is empty.');
    env.VAMPIRE_TOKEN = token;
  }

  await importServer();
}

export function formatCliError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (code === 'EADDRINUSE') {
    return `Vampire could not start: the configured port is already in use. Choose another with --port <number>.`;
  }
  if (code === 'EACCES') {
    return 'Vampire could not start: permission was denied for the configured host or port.';
  }
  if (typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS_')) {
    return `Vampire could not parse the command line: ${message}\nRun vampire --help for usage.`;
  }
  return `Vampire could not start: ${message}`;
}
