import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const backendOrigin = process.env.VAMPIRE_DEV_SERVER_URL?.trim() || 'http://localhost:7677';
const buildDirectory = process.env.VAMPIRE_BUILD_DIR?.trim() || 'build';

export default defineConfig({
  plugins: [react()],
  publicDir: resolve(import.meta.dirname, '../../static'),
  resolve: {
    alias: [
      { find: '~/lib', replacement: resolve(import.meta.dirname, '../../src/lib') },
      { find: '~', replacement: resolve(import.meta.dirname, 'src') },
      { find: '@vampire', replacement: resolve(import.meta.dirname, '../../src') },
    ],
  },
  build: {
    outDir: resolve(import.meta.dirname, `../../${buildDirectory}/client`),
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': { target: backendOrigin },
      '/events': { target: backendOrigin },
      '/ws': { target: backendOrigin, ws: true },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    css: true,
  },
});
