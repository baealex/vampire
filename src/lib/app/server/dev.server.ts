import { resolve } from 'node:path';
import { createServer, loadEnv } from 'vite';
import { prepareDevelopmentEnvironment } from '~/lib/server/development-state.ts';
import {
  applyVampireEnvironmentDefaults,
  developmentRuntimeConfig,
  listeningUrl,
} from '~/lib/server/runtime-config.ts';
import { runStateMigrations } from '~/lib/server/state-migrations.ts';
import { initializeAuthentication } from '~/lib/server/token-authentication.ts';
import { createFastifyApp } from './fastify-app.server.ts';
import { installTerminalWebSocket } from './terminal-websocket.server.ts';
import { installWorkspaceAutomationRunner } from './workspace-automation-runner.server.ts';

const fileEnvironment = loadEnv('development', process.cwd(), 'VAMPIRE_');
applyVampireEnvironmentDefaults(fileEnvironment);
delete fileEnvironment.VAMPIRE_TOKEN;
const args = process.argv.slice(2);
const config = developmentRuntimeConfig(args);
const developmentEnvironment = await prepareDevelopmentEnvironment();
if (args.includes('--allow-status-widgets')) process.env.VAMPIRE_ALLOW_STATUS_WIDGET_COMMANDS = '1';
const stateMigration = await runStateMigrations({ stateDirectory: developmentEnvironment.stateDirectory });
await initializeAuthentication();

const api = createFastifyApp();
const closeTerminalSockets = installTerminalWebSocket(api.server);
await api.listen({ host: '127.0.0.1', port: 0 });
const address = api.server.address();
if (!address || typeof address === 'string')
  throw new Error('Fastify development server did not expose a TCP address.');
const apiOrigin = `http://127.0.0.1:${address.port}`;
const proxy = { target: apiOrigin, changeOrigin: false };
const vite = await createServer({
  configFile: resolve(process.cwd(), 'packages/client/vite.config.ts'),
  root: resolve(process.cwd(), 'packages/client'),
  server: {
    host: config.host,
    port: config.port,
    strictPort: true,
    proxy: {
      '/api': proxy,
      '/events': proxy,
      '/ws': { ...proxy, ws: true },
    },
  },
});

let closeAutomationRunner: () => void = () => undefined;
try {
  await vite.listen();
  closeAutomationRunner = await installWorkspaceAutomationRunner();
} catch (error) {
  closeTerminalSockets();
  await Promise.allSettled([vite.close(), api.close()]);
  throw error;
}
vite.printUrls();
if (config.externalAccess)
  console.warn(
    'Development network access is enabled. Vite module and HMR endpoints are not protected by TOKEN authentication; restrict access to trusted VPN or LAN devices.',
  );
console.log(`Vampire runtime URL: ${config.publicOrigin ?? listeningUrl(config)}`);
console.log(
  config.tokenConfigured ? 'TOKEN authentication is enabled.' : 'Local access does not require TOKEN authentication.',
);
console.log(`Workspace roots: ${config.workspaceRoots.join(', ')}`);
console.log(`State directory: ${config.stateDirectory}`);
console.log(`Development tmux socket: ${developmentEnvironment.tmuxSocketName}`);
console.log(`State layout version: ${stateMigration.layoutVersion}`);

let closing = false;
const shutdown = () => {
  if (closing) return;
  closing = true;
  closeAutomationRunner();
  closeTerminalSockets();
  void Promise.allSettled([vite.close(), api.close()]).finally(() => process.exit());
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
