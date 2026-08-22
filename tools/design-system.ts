import { readFile, readdir } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const sourceRoot = join(root, 'src');
const consumerRoots = ['lib/app', 'lib/features', 'lib/widgets'].map((path) => join(sourceRoot, path));
const forbiddenPatterns = [
  /(?:dialog|menu|controls)\.css/,
  /vampire-dialog-(?:primary|secondary|danger|actions|toolbar|empty-state|primary-action)/,
  /vampire-menu-(?:item|separator|heading)/,
  /(?:^|[\s"'])primary-button(?:[\s"']|$)/,
  /(?:^|[\s"'])secondary-button(?:[\s"']|$)/,
  /(?:^|[\s"'])remove-button(?:[\s"']|$)/,
  /(?:^|[\s"'])check-button(?:[\s"']|$)/,
  /(?:^|[\s"'])retry-button(?:[\s"']|$)/,
  /(?:^|[\s"'])save-button(?:[\s"']|$)/,
];

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (extname(entry.name) === '.svelte') files.push(path);
  }
  return files;
}

export async function findDesignSystemViolations(): Promise<string[]> {
  const violations: string[] = [];
  const files = [
    ...(await Promise.all(consumerRoots.map((directory) => sourceFiles(directory)))).flat(),
    join(sourceRoot, 'routes', '+layout.svelte'),
  ];

  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const pattern of forbiddenPatterns) {
      if (pattern.test(source)) violations.push(`${relative(root, file)}: ${pattern}`);
    }
  }

  return violations;
}
