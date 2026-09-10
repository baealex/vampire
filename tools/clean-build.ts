import { rm } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..');
const outputDirectory = process.env.VAMPIRE_BUILD_DIR?.trim() || 'build';
const outputPath = resolve(repositoryRoot, outputDirectory);
const repositoryRelativePath = relative(repositoryRoot, outputPath);

if (!/^build(?:-[^/\\]+)?$/.test(repositoryRelativePath)) {
  throw new Error(`Refusing to clean unexpected build directory: ${outputPath}`);
}

await rm(outputPath, { force: true, recursive: true });
