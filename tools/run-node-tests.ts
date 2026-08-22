import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..');

async function collectNodeTests(directory: string): Promise<string[]> {
  const tests: string[] = [];

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      tests.push(...(await collectNodeTests(path)));
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith('.test.ts') || entry.name.endsWith('.component.test.ts')) {
      continue;
    }

    tests.push(path);
  }

  return tests;
}

const tests = (
  await Promise.all(['src', 'tools'].map((directory) => collectNodeTests(join(repositoryRoot, directory))))
)
  .flat()
  .sort();

if (tests.length === 0) {
  throw new Error('No Node.js tests were found.');
}

const child = spawn(
  process.execPath,
  [
    '--import',
    resolve(repositoryRoot, 'tools/register-ts-alias.mjs'),
    '--test',
    ...tests.map((path) => relative(repositoryRoot, path)),
  ],
  { cwd: repositoryRoot, stdio: 'inherit' }
);

child.once('error', () => {
  process.exitCode = 1;
});

child.once('exit', (code) => {
  process.exitCode = code ?? 1;
});
