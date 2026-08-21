import {
  E2E_HOST,
  E2E_PORT,
  E2E_STATE_DIRECTORY,
  E2E_TOKEN,
  E2E_WORKSPACE_DIRECTORY,
  prepareE2ERuntime,
} from './runtime.ts';

await prepareE2ERuntime();
process.env.VAMPIRE_HOST = E2E_HOST;
process.env.VAMPIRE_PORT = String(E2E_PORT);
process.env.VAMPIRE_TOKEN = E2E_TOKEN;
process.env.VAMPIRE_STATE_DIR = E2E_STATE_DIRECTORY;
process.env.VAMPIRE_WORKSPACE_ROOTS = E2E_WORKSPACE_DIRECTORY;

await import('../src/server/serve.ts');
