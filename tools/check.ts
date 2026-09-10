import { spawn } from 'node:child_process';
import { join } from 'node:path';

const binSuffix = process.platform === 'win32' ? '.cmd' : '';
const bin = (name: string) => join(process.cwd(), 'node_modules', '.bin', `${name}${binSuffix}`);

function run(command: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env: process.env, stdio: 'inherit' });
    child.once('error', () => resolve(1));
    child.once('exit', (code) => resolve(code ?? 1));
  });
}

const checks: Array<[string, string[]]> = [
  [process.execPath, ['tools/check-architecture.ts']],
  [process.execPath, ['tools/check-design-system.ts']],
  ['tsc', ['--project', 'tsconfig.node.json']],
  ['tsc', ['--project', 'tsconfig.test.json']],
  [process.execPath, ['node_modules/typescript/bin/tsc', '--project', 'packages/client/tsconfig.json']],
];

for (const [command, args] of checks) {
  const executable = command === process.execPath ? command : bin(command);
  const code = await run(executable, args);
  if (code !== 0) {
    process.exitCode = code;
    break;
  }
}
