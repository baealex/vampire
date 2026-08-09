import { createServer } from 'vite';
import type { Server as NodeHttpServer } from 'node:http';
import { runtimeConfig } from '../src/lib/server/runtime-config.ts';
import { installTerminalWebSocket } from './websocket.ts';
import { installWorkspaceWebSocket } from './workspace-websocket.ts';

const config = runtimeConfig();
const vite = await createServer({
	server: {
		host: config.host,
		port: config.port,
		strictPort: true
	}
});

if (!vite.httpServer) throw new Error('Vite did not create an HTTP server.');
// This development configuration does not enable Vite's HTTP/2 mode.
const httpServer = vite.httpServer as NodeHttpServer;
const closeTerminalSockets = installTerminalWebSocket(httpServer);
const closeWorkspaceSockets = installWorkspaceWebSocket(httpServer);

await vite.listen();
vite.printUrls();
console.log(config.tokenConfigured
	? 'Token authentication is enabled.'
	: config.unauthenticatedRemoteAccess
		? 'Warning: token authentication is disabled on a non-loopback address.'
		: 'Local-only mode: no token configured.');

let closing = false;
const shutdown = () => {
	if (closing) return;
	closing = true;
	closeTerminalSockets();
	closeWorkspaceSockets();
	void vite.close().finally(() => process.exit());
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
