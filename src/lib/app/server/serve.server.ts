import { createServer, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { pathToFileURL } from 'node:url';
import {
  configureAdapterRequestOrigin,
  listeningUrl,
  requestHostAllowed,
  runtimeConfig,
} from '~/lib/server/runtime-config.ts';
import { initializeAuthentication } from '~/lib/server/token-authentication.ts';
import { rejectWebSocketUpgrade, webSocketRequestUrl } from '~/lib/server/websocket-support.ts';
import { resolveAdapterHandlerPath } from './adapter-handler-path.server.ts';
import { installTerminalWebSocket } from './terminal-websocket.server.ts';
import { installWorkspaceWebSocket } from './workspace-websocket.server.ts';
import { installWorkspaceAutomationRunner } from './workspace-automation-runner.server.ts';

// Image uploads allow files up to 10 MB; the adapter otherwise defaults to 512 KB.
if (!process.env.VAMPIRE_ADAPTER_BODY_SIZE_LIMIT?.trim()) {
  process.env.VAMPIRE_ADAPTER_BODY_SIZE_LIMIT = '11M';
}

const config = runtimeConfig();
await initializeAuthentication();
const originPolicy = configureAdapterRequestOrigin(config);
const injectedProtocolHeader = originPolicy.injectedProtocolHeader;
const adapterOutputDirectory = process.env.VAMPIRE_BUILD_DIR?.trim() || 'build';
const handlerPath = resolveAdapterHandlerPath(import.meta.dirname, adapterOutputDirectory);
const handlerUrl = pathToFileURL(handlerPath);
const { handler } = await import(handlerUrl.href);
const server = createServer((request, response) => {
  if (!requestHostAllowed(request.headers)) {
    response.writeHead(421, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' });
    response.end('Misdirected Request');
    return;
  }
  if (injectedProtocolHeader) request.headers[injectedProtocolHeader] = 'http';
  void handler(request, response);
});
if (injectedProtocolHeader) {
  server.on('upgrade', (request) => {
    request.headers[injectedProtocolHeader] = 'http';
  });
}

await new Promise<void>((resolve, reject) => {
  const handleError = (error: Error) => reject(error);
  server.once('error', handleError);
  server.listen(config.port, config.host, () => {
    server.off('error', handleError);
    resolve();
  });
});

let closeTerminalSockets: () => void = () => undefined;
let closeWorkspaceSockets: () => void = () => undefined;
let closeUnsupportedUpgradeRejection: () => void = () => undefined;
let closeAutomationRunner: () => void = () => undefined;
try {
  closeTerminalSockets = installTerminalWebSocket(server);
  closeWorkspaceSockets = installWorkspaceWebSocket(server);
  const rejectUnsupportedUpgrade = (request: IncomingMessage, socket: Duplex) => {
    const url = webSocketRequestUrl(request);
    if (!url) {
      rejectWebSocketUpgrade(socket, 400, 'Bad Request');
      return;
    }
    if (url.pathname === '/ws/terminal' || url.pathname === '/ws/workspace') return;
    rejectWebSocketUpgrade(socket, 404, 'Not Found');
  };
  server.on('upgrade', rejectUnsupportedUpgrade);
  closeUnsupportedUpgradeRejection = () => server.off('upgrade', rejectUnsupportedUpgrade);
  closeAutomationRunner = await installWorkspaceAutomationRunner();
} catch (error) {
  closeUnsupportedUpgradeRejection();
  closeTerminalSockets();
  closeWorkspaceSockets();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  throw error;
}

console.log(`Vampire listening at ${config.publicOrigin ?? listeningUrl(config)}`);
if (config.host === '0.0.0.0' || config.host === '::') {
  console.log(`Bound to all interfaces (${config.host}:${config.port}).`);
}
if (config.tokenConfigured) {
  console.log('TOKEN authentication is enabled.');
} else if (config.externalAccess) {
  console.log('Warning: external access is running without TOKEN authentication.');
} else {
  console.log('Local access does not require TOKEN authentication.');
}
console.log(`Workspace roots: ${config.workspaceRoots.join(', ')}`);
console.log(`State directory: ${config.stateDirectory}`);

let closing = false;
const shutdown = () => {
  if (closing) return;
  closing = true;
  closeAutomationRunner();
  closeUnsupportedUpgradeRejection();
  closeTerminalSockets();
  closeWorkspaceSockets();
  const forceCloseTimer = setTimeout(() => server.closeAllConnections(), 5_000);
  forceCloseTimer.unref();
  server.close((error) => {
    clearTimeout(forceCloseTimer);
    if (error) {
      console.error(error);
      process.exitCode = 1;
    }
    process.exit();
  });
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
