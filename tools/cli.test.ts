import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, '..');
const executable = resolve(repositoryRoot, 'bin/vampire.js');

test('the CLI exposes help and the installed version without starting the server', async () => {
  const help = await execFileAsync(process.execPath, [executable, '--help'], { cwd: repositoryRoot });
  assert.match(help.stdout, /Usage: vampire \[options\]/);
  assert.match(help.stdout, /--port <number>/);

  const manifest = JSON.parse(await readFile(resolve(repositoryRoot, 'package.json'), 'utf8')) as { version: string };
  const version = await execFileAsync(process.execPath, [executable, '--version'], { cwd: repositoryRoot });
  assert.equal(version.stdout.trim(), `vampire ${manifest.version}`);
});

test('the CLI rejects unknown options with a usage hint', async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [executable, '--token', 'do-not-put-tokens-in-argv'], { cwd: repositoryRoot }),
    (error: unknown) => {
      const stderr = (error as { stderr?: string }).stderr ?? '';
      assert.match(stderr, /could not parse the command line/);
      assert.match(stderr, /--help/);
      return true;
    }
  );
});

test('CLI configuration follows CLI, process, env-file, and default precedence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vampire-cli-'));
  try {
    const environmentFile = join(directory, 'vampire.env');
    const tokenFile = join(directory, 'token');
    await writeFile(
      environmentFile,
      ['VAMPIRE_HOST=file-host', 'VAMPIRE_PORT=7000', 'VAMPIRE_TOKEN=file-token'].join('\n')
    );
    await writeFile(tokenFile, 'token-file-value\n');

    const script = `
      const { runCli } = await import('./bin/cli.js');
      const env = { VAMPIRE_HOST: 'shell-host' };
      await runCli({
        args: ${JSON.stringify([
          '--env-file',
          environmentFile,
          '--port',
          '9000',
          '--origin',
          'https://vampire.example.com',
          '--workspace-root',
          '/tmp/one',
          '--workspace-root',
          '/tmp/two',
          '--token-file',
          tokenFile,
        ])},
        cwd: ${JSON.stringify(directory)},
        env,
        write: () => undefined,
        importServer: async () => undefined,
      });
      process.stdout.write(JSON.stringify(env));
    `;
    const result = await execFileAsync(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: repositoryRoot,
    });
    const environment = JSON.parse(result.stdout) as NodeJS.ProcessEnv;

    assert.equal(environment.VAMPIRE_HOST, 'shell-host');
    assert.equal(environment.VAMPIRE_PORT, '9000');
    assert.equal(environment.VAMPIRE_PUBLIC_ORIGIN, 'https://vampire.example.com');
    assert.equal(environment.VAMPIRE_ADAPTER_ORIGIN, 'https://vampire.example.com');
    assert.equal(environment.VAMPIRE_TOKEN, 'token-file-value');
    assert.equal(environment.VAMPIRE_WORKSPACE_ROOTS, ['/tmp/one', '/tmp/two'].join(delimiter));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the CLI formats bind failures without exposing a stack trace', async () => {
  const script = `
    const { formatCliError } = await import('./bin/cli.js');
    const error = Object.assign(new Error('listen EADDRINUSE: address already in use'), { code: 'EADDRINUSE' });
    process.stdout.write(formatCliError(error));
  `;
  const result = await execFileAsync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: repositoryRoot,
  });

  assert.match(result.stdout, /configured port is already in use/);
  assert.match(result.stdout, /--port/);
  assert.doesNotMatch(result.stdout, /\n\s+at /);
});
