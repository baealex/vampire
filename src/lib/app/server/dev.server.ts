import { createServer, loadEnv } from 'vite';
import { initializeAuthentication } from '~/lib/server/token-authentication.ts';
import {
  applyVampireEnvironmentDefaults,
  developmentRuntimeConfig,
  listeningUrl,
} from '~/lib/server/runtime-config.ts';
import { prepareDevelopmentEnvironment } from '~/lib/server/development-state.ts';
import { runStateMigrations } from '~/lib/server/state-migrations.ts';
import { installWorkspaceAutomationRunner } from './workspace-automation-runner.server.ts';

const fileEnvironment = loadEnv('development', process.cwd(), 'VAMPIRE_');
applyVampireEnvironmentDefaults(fileEnvironment);
delete fileEnvironment.VAMPIRE_TOKEN;
const config = developmentRuntimeConfig(process.argv.slice(2));
const developmentEnvironment = await prepareDevelopmentEnvironment();
const stateMigration = await runStateMigrations({ stateDirectory: developmentEnvironment.stateDirectory });

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
if (config.externalAccess) {
  console.warn(
    'Development network access is enabled. Vite module and HMR endpoints are not protected by TOKEN authentication; restrict access to trusted VPN or LAN devices.'
  );
}
console.log(`Vampire runtime URL: ${config.publicOrigin ?? listeningUrl(config)}`);
console.log(
  config.tokenConfigured ? 'TOKEN authentication is enabled.' : 'Local access does not require TOKEN authentication.'
);
console.log(`Workspace roots: ${config.workspaceRoots.join(', ')}`);
console.log(`State directory: ${config.stateDirectory}`);
console.log(`Development tmux socket: ${developmentEnvironment.tmuxSocketName}`);
console.log(`State layout version: ${stateMigration.layoutVersion}`);
console.log('Automatic startup profiles, scheduled prompts, and status widget commands are disabled.');
console.log('User-triggered agent request imports remain enabled.');

let closing = false;
const shutdown = () => {
  if (closing) return;
  closing = true;
  closeAutomationRunner();
  void vite.close().finally(() => process.exit());
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
