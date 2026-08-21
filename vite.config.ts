import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, type Plugin } from 'vite';
import type { Server as NodeHttpServer } from 'node:http';
import { installTerminalWebSocket } from './runtime/websocket.ts';
import { installWorkspaceWebSocket } from './runtime/workspace-websocket.ts';

const viteCacheDirectory = process.env.VAMPIRE_VITE_CACHE_DIR?.trim() || 'node_modules/.vite';

function vampireRuntimeWebSocketPlugin(): Plugin {
  return {
    name: 'vampire-runtime-websockets',
    configureServer(server) {
      if (!server.httpServer) return;

      // The dev runtime intentionally uses Vite's plain HTTP server. Vite's
      // public type also allows HTTP/2, so narrow it at this integration point.
      const httpServer = server.httpServer as NodeHttpServer;
      const closeTerminalWebSocket = installTerminalWebSocket(httpServer);
      const closeWorkspaceWebSocket = installWorkspaceWebSocket(httpServer);
      let closed = false;
      const closeRuntimeWebSockets = () => {
        if (closed) return;
        closed = true;
        closeTerminalWebSocket();
        closeWorkspaceWebSocket();
      };
      const closeServer = server.close.bind(server);
      server.close = async () => {
        closeRuntimeWebSockets();
        return closeServer();
      };
    },
  };
}

export default defineConfig({
  plugins: [vampireRuntimeWebSocketPlugin(), sveltekit()],
  cacheDir: viteCacheDirectory,
  optimizeDeps: {
    include: ['@codemirror/commands', '@codemirror/state', '@codemirror/view', '@xterm/addon-fit', '@xterm/xterm'],
  },
  server: {
    watch: {
      ignored: ['**/.svelte-kit-check/**', '**/.svelte-kit-e2e/**', '**/build-e2e/**'],
    },
  },
  ssr: {
    noExternal: ['@lucide/svelte'],
  },
});
