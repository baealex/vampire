import { createServer, loadEnv } from 'vite';
import { initializeAuthentication } from '~/lib/server/token-authentication.ts';
import { applyVampireEnvironmentDefaults, listeningUrl, runtimeConfig } from '~/lib/server/runtime-config.ts';
import { prepareDevelopmentEnvironment } from '~/lib/server/development-state.ts';
import { runStateMigrations } from '~/lib/server/state-migrations.ts';
import { installWorkspaceAutomationRunner } from './workspace-automation-runner.server.ts';

const fileEnvironment = loadEnv('development', process.cwd(), 'VAMPIRE_');
applyVampireEnvironmentDefaults(fileEnvironment);
delete fileEnvironment.VAMPIRE_TOKEN;
const developmentEnvironment = await prepareDevelopmentEnvironment();
const stateMigration = await runStateMigrations({ stateDirectory: developmentEnvironment.stateDirectory });

const config = runtimeConfig();
if (config.host === '0.0.0.0' || config.host === '::') {
  throw new Error('The development server requires a specific host address and cannot bind to every interface.');
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
