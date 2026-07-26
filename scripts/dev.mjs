import { createServer } from 'vite';
import { runtimeConfig } from './config.mjs';
import { installTerminalWebSocket } from './websocket.mjs';

const config = runtimeConfig();
const vite = await createServer({
	server: {
		host: config.host,
		port: config.port,
		strictPort: true
	}
});

if (!vite.httpServer) throw new Error('Vite did not create an HTTP server.');
const closeTerminalSockets = installTerminalWebSocket(vite.httpServer);

await vite.listen();
vite.printUrls();
console.log(config.tokenConfigured ? 'Token authentication is enabled.' : 'Local-only mode: no token configured.');

let closing = false;
const shutdown = () => {
	if (closing) return;
	closing = true;
	closeTerminalSockets();
	void vite.close().finally(() => process.exit());
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
