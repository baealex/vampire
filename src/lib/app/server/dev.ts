import { createServer } from 'vite';
import { runtimeConfig } from '~/lib/shared/server/runtime-config.ts';
import { installKingControlServer } from './king-control-server.ts';
import { installKingOrchestrationRunner } from './king-orchestration-runner.ts';
import { installWorkspaceAutomationRunner } from './workspace-automation-runner.ts';

const config = runtimeConfig();
const vite = await createServer({
  server: {
    host: config.host,
    port: config.port,
    strictPort: true,
  },
});

const closeAutomationRunner = await installWorkspaceAutomationRunner();
const closeKingControl = await installKingControlServer();
const closeKingOrchestration = await installKingOrchestrationRunner();

await vite.listen();
vite.printUrls();
console.log(
  config.tokenConfigured
    ? 'Token authentication is enabled.'
    : config.unauthenticatedRemoteAccess
      ? 'Warning: token authentication is disabled on a non-loopback address.'
      : 'Local-only mode: no token configured.'
);

let closing = false;
const shutdown = () => {
  if (closing) return;
  closing = true;
  closeKingOrchestration();
  closeKingControl();
  closeAutomationRunner();
  void vite.close().finally(() => process.exit());
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
