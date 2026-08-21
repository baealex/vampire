import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const write = process.argv.includes('--write');
const supportedFile = /\.(?:css|gql|graphql|html|js|jsx|json|jsonc|svelte|ts|tsx)$/;

function gitFiles(args: string[]): string[] {
  return execFileSync('git', args, { encoding: 'utf8' })
    .split('\n')
    .map((file) => file.trim())
    .filter(Boolean);
}

const files = [
  ...new Set([
    ...gitFiles(['diff', '--name-only', '--diff-filter=ACMR']),
    ...gitFiles(['diff', '--cached', '--name-only', '--diff-filter=ACMR']),
    ...gitFiles(['ls-files', '--others', '--exclude-standard']),
  ]),
].filter((file) => supportedFile.test(file) && existsSync(file));

if (files.length === 0) {
  console.log('No changed files to format.');
  process.exit(0);
}

const biome = join(process.cwd(), 'node_modules', '.bin', 'biome');
const result = spawnSync(biome, ['format', ...(write ? ['--write'] : []), ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
