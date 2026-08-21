import assert from 'node:assert/strict';
import test from 'node:test';
import {
  runStatusPluginCommand,
  StatusPluginCommandError,
} from '../src/lib/features/status/server/status-plugin-command.ts';

test('runs a status command in a shell and captures bounded output', async () => {
  const result = await runStatusPluginCommand("printf 'ready\\ndetail\\n'");
  assert.equal(result.stdout, 'ready\ndetail\n');
  assert.equal(result.stderr, '');
});

test('reports non-zero commands without treating stderr as status text', async () => {
  await assert.rejects(
    runStatusPluginCommand("printf 'bad news' >&2; exit 7"),
    (error: unknown) =>
      error instanceof StatusPluginCommandError &&
      error.kind === 'exit' &&
      error.exitCode === 7 &&
      error.stderr === 'bad news'
  );
});

test('terminates commands that exceed their time or output budget', async () => {
  await assert.rejects(
    runStatusPluginCommand('sleep 2', { timeoutMs: 50 }),
    (error: unknown) => error instanceof StatusPluginCommandError && error.kind === 'timeout'
  );
  await assert.rejects(
    runStatusPluginCommand("printf '%04096d' 0", { maxOutputBytes: 128 }),
    (error: unknown) => error instanceof StatusPluginCommandError && error.kind === 'output-limit'
  );
});

test('does not leave detached command children running after a refresh', async (t) => {
  const result = await runStatusPluginCommand('sleep 30 >/dev/null 2>&1 & printf \'%s\' "$!"');
  const pid = Number(result.stdout);
  assert.equal(Number.isInteger(pid) && pid > 0, true);
  t.after(() => {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already cleaned up by the command runner.
    }
  });

  await assert.rejects(
    async () => {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
          process.kill(pid, 0);
          await new Promise((resolve) => setTimeout(resolve, 10));
        } catch (error) {
          throw error;
        }
      }
    },
    (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ESRCH'
  );
});
