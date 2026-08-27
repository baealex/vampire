import { createServer, loadEnv } from 'vite';
import { applyVampireEnvironmentDefaults, listeningUrl, runtimeConfig } from '~/lib/server/runtime-config.ts';
import { installKingControlServer } from './king-control-server.server.ts';
import { installKingOrchestrationRunner } from './king-orchestration-runner.server.ts';
import { installWorkspaceAutomationRunner } from './workspace-automation-runner.server.ts';

const fileEnvironment = loadEnv('development', process.cwd(), 'VAMPIRE_');
applyVampireEnvironmentDefaults(fileEnvironment);

const config = runtimeConfig();
const vite = await createServer({
  server: {
    host: config.host,
    port: config.port,
    strictPort: true,
  },
});

await vite.listen();
let closeAutomationRunner: () => void = () => undefined;
let closeKingControl: () => void = () => undefined;
let closeKingOrchestration: () => void = () => undefined;
try {
  closeAutomationRunner = await installWorkspaceAutomationRunner();
  closeKingControl = await installKingControlServer();
  closeKingOrchestration = await installKingOrchestrationRunner();
} catch (error) {
  closeKingOrchestration();
  closeKingControl();
  closeAutomationRunner();
  await vite.close();
  throw error;
}
vite.printUrls();
console.log(`Vampire runtime URL: ${config.publicOrigin ?? listeningUrl(config)}`);
console.log(
  config.tokenConfigured
    ? 'Token authentication is enabled.'
    : config.unauthenticatedRemoteAccess
      ? 'Warning: token authentication is disabled on a non-loopback address.'
      : 'Local-only mode: no token configured.'
);
console.log(`Workspace roots: ${config.workspaceRoots.join(', ')}`);
console.log(`State directory: ${config.stateDirectory}`);

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
