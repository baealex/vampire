import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';

const gzipAsync = promisify(gzip);

export async function compressClientDirectory(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await compressClientDirectory(path);
    else if (entry.isFile() && /\.(?:js|css|html|svg|json|webmanifest)$/.test(entry.name)) {
      const content = await readFile(path);
      if (content.length < 1_024) continue;
      const compressed = await gzipAsync(content, { level: 9 });
      if (compressed.length < content.length) await writeFile(`${path}.gz`, compressed);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const buildDirectory = process.env.VAMPIRE_BUILD_DIR?.trim() || 'build';
  await compressClientDirectory(resolve(import.meta.dirname, '..', buildDirectory, 'client'));
}
