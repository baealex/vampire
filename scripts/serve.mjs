import { createServer } from 'node:http';
import { runtimeConfig } from './config.mjs';
import { installTerminalWebSocket } from './websocket.mjs';

// Image uploads allow files up to 10 MB; the adapter otherwise defaults to 512 KB.
if (!process.env.VAMPIRE_ADAPTER_BODY_SIZE_LIMIT?.trim()) {
	process.env.VAMPIRE_ADAPTER_BODY_SIZE_LIMIT = '11M';
}

const config = runtimeConfig();
const { handler } = await import('../build/handler.js');
const server = createServer(handler);
const closeTerminalSockets = installTerminalWebSocket(server);

server.listen(config.port, config.host, () => {
	console.log(`Vampire listening on http://${config.host}:${config.port}`);
	console.log(config.tokenConfigured ? 'Token authentication is enabled.' : 'Local-only mode: no token configured.');
});

let closing = false;
const shutdown = () => {
	if (closing) return;
	closing = true;
	closeTerminalSockets();
	server.close((error) => {
		if (error) {
			console.error(error);
			process.exitCode = 1;
		}
		process.exit();
	});
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
