import { createServer, loadEnv } from 'vite';
import { initializeAuthentication } from '~/lib/server/token-authentication.ts';
import {
  applyVampireEnvironmentDefaults,
  isLoopbackHost,
  listeningUrl,
  runtimeConfig,
} from '~/lib/server/runtime-config.ts';
import { installWorkspaceAutomationRunner } from './workspace-automation-runner.server.ts';

const fileEnvironment = loadEnv('development', process.cwd(), 'VAMPIRE_');
applyVampireEnvironmentDefaults(fileEnvironment);
delete fileEnvironment.VAMPIRE_TOKEN;

const config = runtimeConfig();
if (!isLoopbackHost(config.host)) {
  throw new Error('The development server is restricted to localhost. Use the production server for remote access.');
}
await initializeAuthentication();
const vite = await createServer({
  server: {
    host: config.host,
    port: config.port,
    strictPort: true,
  },
});

await vite.listen();
let closeAutomationRunner: () => void;
try {
  closeAutomationRunner = await installWorkspaceAutomationRunner();
} catch (error) {
  await vite.close();
  throw error;
}
vite.printUrls();
console.log(`Vampire runtime URL: ${config.publicOrigin ?? listeningUrl(config)}`);
console.log(config.tokenConfigured ? 'TOKEN authentication is enabled.' : 'Warning: TOKEN authentication is disabled.');
console.log(`Workspace roots: ${config.workspaceRoots.join(', ')}`);
console.log(`State directory: ${config.stateDirectory}`);

let closing = false;
const shutdown = () => {
  if (closing) return;
  closing = true;
  closeAutomationRunner();
  void vite.close().finally(() => process.exit());
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
