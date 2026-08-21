import { createServer } from 'vite';
import { runtimeConfig } from '../src/lib/server/runtime-config.ts';
import { installSessionAutomationRunner } from './session-automations.ts';

const config = runtimeConfig();
const vite = await createServer({
  server: {
    host: config.host,
    port: config.port,
    strictPort: true,
  },
});

const closeAutomationRunner = await installSessionAutomationRunner();

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
  closeAutomationRunner();
  void vite.close().finally(() => process.exit());
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
