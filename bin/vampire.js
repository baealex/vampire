#!/usr/bin/env node

import { formatCliError, runCli } from './cli.js';

try {
  await runCli();
} catch (error) {
  console.error(formatCliError(error));
  process.exitCode = 1;
}
