import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  noExternal: [/@vampire\/server/],
  external: ['@prisma/client', 'prisma', 'fastify', '@fastify/static', 'commander'],
  banner: {
    js: '#!/usr/bin/env node',
  },
});
