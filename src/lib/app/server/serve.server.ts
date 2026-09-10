import type { IncomingMessage } from 'node:http';
import { resolve } from 'node:path';
import type { Duplex } from 'node:stream';
import { configureAdapterRequestOrigin, listeningUrl, runtimeConfig } from '~/lib/server/runtime-config.ts';
import { initializeAuthentication } from '~/lib/server/token-authentication.ts';
import { runStateMigrations } from '~/lib/server/state-migrations.ts';
import { rejectWebSocketUpgrade, webSocketRequestUrl } from '~/lib/server/websocket-support.ts';
import { createFastifyApp } from './fastify-app.server.ts';
import { installTerminalWebSocket } from './terminal-websocket.server.ts';
import { installWorkspaceAutomationRunner } from './workspace-automation-runner.server.ts';

const config = runtimeConfig();
const stateMigration = await runStateMigrations({ stateDirectory: config.stateDirectory });
await initializeAuthentication();
const originPolicy = configureAdapterRequestOrigin(config);

const clientDirectory = process.env.VAMPIRE_CLIENT_DIR?.trim() || resolve(import.meta.dirname, 'client');
const app = createFastifyApp({
  clientDirectory,
  injectedProtocolHeader: originPolicy.injectedProtocolHeader,
});
if (originPolicy.injectedProtocolHeader) {
  app.server.on('upgrade', (request) => {
    request.headers[originPolicy.injectedProtocolHeader!] = 'http';
  });
}
const closeTerminalSockets = installTerminalWebSocket(app.server);
const rejectUnsupportedUpgrade = (request: IncomingMessage, socket: Duplex) => {
  const url = webSocketRequestUrl(request);
  if (!url) {
    rejectWebSocketUpgrade(socket, 400, 'Bad Request');
    return;
  }
  if (url.pathname === '/ws/terminal') return;
  rejectWebSocketUpgrade(socket, 404, 'Not Found');
};
app.server.on('upgrade', rejectUnsupportedUpgrade);

let closeAutomationRunner: () => void = () => undefined;
try {
  closeAutomationRunner = await installWorkspaceAutomationRunner();
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.server.off('upgrade', rejectUnsupportedUpgrade);
  closeTerminalSockets();
  closeAutomationRunner();
  await app.close();
  throw error;
}

console.log(`Vampire listening at ${config.publicOrigin ?? listeningUrl(config)}`);
if (config.host === '0.0.0.0' || config.host === '::')
  console.log(`Bound to all interfaces (${config.host}:${config.port}).`);
console.log(
  config.tokenConfigured
    ? 'TOKEN authentication is enabled.'
    : config.externalAccess
      ? 'Warning: external access is running without TOKEN authentication.'
      : 'Local access does not require TOKEN authentication.'
);
console.log(`Workspace roots: ${config.workspaceRoots.join(', ')}`);
console.log(`State directory: ${config.stateDirectory}`);
console.log(`State layout version: ${stateMigration.layoutVersion}`);

let closing = false;
const shutdown = () => {
  if (closing) return;
  closing = true;
  closeAutomationRunner();
  app.server.off('upgrade', rejectUnsupportedUpgrade);
  closeTerminalSockets();
  const forceCloseTimer = setTimeout(() => app.server.closeAllConnections(), 5_000);
  forceCloseTimer.unref();
  void app.close().then(
    () => {
      clearTimeout(forceCloseTimer);
      process.exit();
    },
    (error) => {
      clearTimeout(forceCloseTimer);
      console.error(error);
      process.exitCode = 1;
      process.exit();
    }
  );
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
