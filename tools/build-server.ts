import { build } from 'esbuild';
import { resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..');
const outputDirectory = process.env.VAMPIRE_BUILD_DIR?.trim() || 'build';

await build({
  entryPoints: [resolve(repositoryRoot, 'src/server/serve.ts')],
  outfile: resolve(repositoryRoot, outputDirectory, 'vampire-server.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22.18',
  alias: {
    '~': resolve(repositoryRoot, 'src'),
  },
  packages: 'external',
  legalComments: 'none',
  logLevel: 'info',
});
