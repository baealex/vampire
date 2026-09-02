import { prepareDevelopmentStateCopy } from '../src/lib/server/development-state.ts';

const HELP = `Usage: pnpm dev:state:prepare -- --source <path> --target <new-path>

Creates a fresh development-only snapshot while the installed Vampire can keep running.

Options:
  --source <path>   Existing state directory to read without modifying
  --target <path>   New directory to create; existing paths are refused
  --help            Show this help

The command excludes worktrees, agent support files, pending requests, backups,
locks, and temporary files. It retries if state changes, validates the staged
copy, applies pending layout migrations, and publishes the target atomically.
`;

type Arguments = {
  source?: string;
  target?: string;
  help: boolean;
};

function parseArguments(values: string[]): Arguments {
  const parsed: Arguments = { help: false };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--') continue;
    if (value === '--help') {
      parsed.help = true;
      continue;
    }
    if (value !== '--source' && value !== '--target') throw new Error(`Unknown option: ${value}`);
    const path = values[index + 1];
    if (!path || path.startsWith('--')) throw new Error(`${value} requires a path.`);
    if (value === '--source') {
      if (parsed.source !== undefined) throw new Error('--source may only be provided once.');
      parsed.source = path;
    } else {
      if (parsed.target !== undefined) throw new Error('--target may only be provided once.');
      parsed.target = path;
    }
    index += 1;
  }
  return parsed;
}

try {
  const args = parseArguments(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
  } else {
    if (!args.source || !args.target) throw new Error('--source and --target are required.');
    const result = await prepareDevelopmentStateCopy({
      sourceDirectory: args.source,
      targetDirectory: args.target,
    });
    process.stdout.write(
      [
        `Prepared development state: ${result.stateDirectory}`,
        `Copied ${result.fileCount} files (${result.totalBytes} bytes) in ${result.attempts} snapshot attempt(s).`,
        `State layout version: ${result.layoutVersion}.`,
        'Set VAMPIRE_STATE_DIR to this exact directory when starting pnpm dev.',
        'Automatic startup profiles, automations, and status widget commands will remain disabled.',
        '',
      ].join('\n')
    );
  }
} catch (error) {
  const message = error instanceof Error ? error.message : 'Unable to prepare development state.';
  process.stderr.write(`${message}\n\n${HELP}`);
  process.exitCode = 1;
}
