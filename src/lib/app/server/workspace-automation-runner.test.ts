import assert from 'node:assert/strict';
import test from 'node:test';
import { automationSubmissionTerminal, prepareAutomationSubmission } from './workspace-automation-runner.ts';
import type { StoredWorkspace } from '~/lib/features/workspace/server/workspace-store.ts';
import type { TmuxSession } from '~/lib/features/terminal/server/tmux.ts';
import type { WorkspaceAutomation } from '~/lib/shared/contracts/workspace-automations.ts';

const running: TmuxSession = {
  name: 'vampire-workspace-1',
  createdAt: 1,
  lastOutputAt: 1,
  attachedClients: 0,
  foregroundProcess: { kind: 'command', label: 'codex' },
  terminals: [
    {
      id: '@1',
      index: 0,
      name: 'main',
      active: false,
      lastOutputAt: 1,
      foregroundProcess: { kind: 'command', label: 'codex' },
      command: null,
      startedAt: null,
      state: 'running',
      exitCode: null,
    },
    {
      id: '@2',
      index: 1,
      name: 'server',
      active: true,
      lastOutputAt: 2,
      foregroundProcess: { kind: 'command', label: 'node' },
      command: 'pnpm dev',
      startedAt: 1,
      state: 'running',
      exitCode: null,
    },
  ],
};

const stored: StoredWorkspace = {
  id: 'workspace-1',
  tmuxSession: running.name,
  cwd: '/tmp/workspace',
  createdAt: 1,
  lastActiveAt: 1,
  automations: [],
  favoriteCommands: [],
  startupProfileId: null,
};

const automation: WorkspaceAutomation = {
  id: 'automation-1',
  kind: 'custom',
  name: 'Review',
  prompt: 'Review the current work.',
  schedule: { type: 'once', runAt: 1 },
  enabled: true,
  nextRunAt: 1,
  createdAt: 1,
  updatedAt: 1,
  lastAttemptAt: null,
  lastRunAt: null,
  lastOutcome: null,
  lastError: null,
};

test('automation submission targets only the waiting recognized agent in the main terminal', () => {
  assert.equal(automationSubmissionTerminal(running, 'waiting')?.id, '@1');
  assert.equal(automationSubmissionTerminal(running, 'working'), undefined);
  assert.equal(
    automationSubmissionTerminal(
      {
        ...running,
        terminals: [{ ...running.terminals[0], foregroundProcess: { kind: 'shell', label: 'zsh' } }],
      },
      'waiting'
    ),
    undefined
  );
});

test('prepares one literal prompt submission only after the live waiting-state check', async () => {
  const submissions: Array<[string, string, string]> = [];
  const ready = await prepareAutomationSubmission(stored, automation, {
    listTmuxSessions: async () => [running],
    readAgentStates: async () => new Map([[stored.id, 'waiting']]),
    submitPrompt: async (...input) => {
      submissions.push(input);
    },
  });
  assert.ok(ready);
  await ready();
  assert.deepEqual(submissions, [[running.name, '@1', automation.prompt]]);

  assert.equal(
    await prepareAutomationSubmission(stored, automation, {
      listTmuxSessions: async () => [running],
      readAgentStates: async () => new Map([[stored.id, 'working']]),
      submitPrompt: async () => undefined,
    }),
    undefined
  );
});
