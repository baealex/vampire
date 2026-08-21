import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runtimeConfig } from '../src/lib/server/runtime-config.ts';
import { installTerminalWebSocket } from './websocket.ts';
import { installWorkspaceWebSocket } from './workspace-websocket.ts';
import { installSessionAutomationRunner } from './session-automations.ts';

const DEFAULT_PROTOCOL_HEADER = 'x-forwarded-proto';

// Image uploads allow files up to 10 MB; the adapter otherwise defaults to 512 KB.
if (!process.env.VAMPIRE_ADAPTER_BODY_SIZE_LIMIT?.trim()) {
  process.env.VAMPIRE_ADAPTER_BODY_SIZE_LIMIT = '11M';
}

const protocolHeader = process.env.VAMPIRE_ADAPTER_PROTOCOL_HEADER?.trim().toLowerCase() || DEFAULT_PROTOCOL_HEADER;
if (!process.env.VAMPIRE_ADAPTER_PROTOCOL_HEADER?.trim()) {
  process.env.VAMPIRE_ADAPTER_PROTOCOL_HEADER = protocolHeader;
}

const config = runtimeConfig();
const repositoryRoot = resolve(import.meta.dirname, '..');
const adapterOutputDirectory = process.env.VAMPIRE_BUILD_DIR?.trim() || 'build';
const handlerPath = resolve(repositoryRoot, adapterOutputDirectory, 'handler.js');
const handlerUrl = pathToFileURL(handlerPath);
const { handler } = await import(handlerUrl.href);
const server = createServer((request, response) => {
  if (!request.headers[protocolHeader]) request.headers[protocolHeader] = 'http';
  void handler(request, response);
});
const closeTerminalSockets = installTerminalWebSocket(server);
const closeWorkspaceSockets = installWorkspaceWebSocket(server);
const closeAutomationRunner = await installSessionAutomationRunner();

server.listen(config.port, config.host, () => {
  console.log(`Vampire listening on http://${config.host}:${config.port}`);
  console.log(
    config.tokenConfigured
      ? 'Token authentication is enabled.'
      : config.unauthenticatedRemoteAccess
        ? 'Warning: token authentication is disabled on a non-loopback address.'
        : 'Local-only mode: no token configured.'
  );
});

let closing = false;
const shutdown = () => {
  if (closing) return;
  closing = true;
  closeAutomationRunner();
  closeTerminalSockets();
  closeWorkspaceSockets();
  server.close((error) => {
    if (error) {
      console.error(error);
      process.exitCode = 1;
    }
    process.exit();
  });
  server.closeAllConnections();
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
