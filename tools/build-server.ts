import { build } from 'esbuild';
import { resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..');

await build({
	entryPoints: [resolve(repositoryRoot, 'runtime/serve.ts')],
	outfile: resolve(repositoryRoot, 'build/vampire-server.js'),
	bundle: true,
	format: 'esm',
	platform: 'node',
	target: 'node22.18',
	packages: 'external',
	legalComments: 'none',
	logLevel: 'info'
});
