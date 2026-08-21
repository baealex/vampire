import { spawn } from 'node:child_process';
import { join } from 'node:path';

const binSuffix = process.platform === 'win32' ? '.cmd' : '';
const bin = (name: string) => join(process.cwd(), 'node_modules', '.bin', `${name}${binSuffix}`);
const environment = {
  ...process.env,
  VAMPIRE_SVELTEKIT_OUT_DIR: '.svelte-kit-check',
};

function run(command: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env: environment, stdio: 'inherit' });
    child.once('error', () => resolve(1));
    child.once('exit', (code) => resolve(code ?? 1));
  });
}

const checks: Array<[string, string[]]> = [
  ['svelte-kit', ['sync']],
  ['svelte-check', ['--tsconfig', './tsconfig.check.json']],
  ['tsc', ['--project', 'tsconfig.node.json']],
  ['tsc', ['--project', 'tsconfig.test.json']],
];

for (const [command, args] of checks) {
  const code = await run(bin(command), args);
  if (code !== 0) {
    process.exitCode = code;
    break;
  }
}
