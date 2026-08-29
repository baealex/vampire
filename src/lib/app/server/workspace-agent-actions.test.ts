import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkspaceAutomation } from '~/lib/shared/contracts/workspace-automations.ts';
import type { ManagedWorkspace } from './workspace-registry.server.ts';
import {
  describeWorkspaceAgentAction,
  queueWorkspaceAgentAction,
  WorkspaceAgentActionError,
  type WorkspaceAgentActionDependencies,
} from './workspace-agent-actions.server.ts';

function workspace(): ManagedWorkspace {
  return {
    id: 'workspace-1',
    tmuxSession: 'vampire-workspace-1',
    cwd: '/project',
    workspaceKind: 'directory',
    workspaceLabel: 'Project',
    createdAt: 1,
    lastActiveAt: 1,
    favoriteCommands: [],
    startupProfileId: null,
    notePreview: '',
    state: 'running',
    lastOutputAt: 1,
    attachedClients: 0,
    foregroundProcess: { kind: 'command', label: 'codex' },
    terminals: [
      {
        id: '@1',
        index: 0,
        name: 'main',
        active: true,
        lastOutputAt: 1,
        foregroundProcess: { kind: 'command', label: 'codex' },
        command: null,
        startedAt: null,
        state: 'running',
        exitCode: null,
      },
    ],
    agentState: 'waiting',
    isGitRepository: true,
    workspaceAvailable: true,
  };
}

function queuedAutomation(actionId: 'note' | 'status-widget', prompt: string, now: number): WorkspaceAutomation {
  return {
    id: 'request-1',
    kind: 'agent-action',
    agentActionId: actionId,
    name: 'Agent request',
    prompt,
    schedule: { type: 'once', runAt: now },
    enabled: true,
    nextRunAt: now,
    createdAt: now,
    updatedAt: now,
    lastAttemptAt: null,
    lastRunAt: null,
    lastOutcome: null,
    lastError: null,
  };
}

function dependencies(overrides: Partial<WorkspaceAgentActionDependencies> = {}): WorkspaceAgentActionDependencies {
  return {
    findWorkspace: async () => workspace(),
    ensureNoteFile: async () => '/state/workspace-1.note.md',
    notePath: () => '/state/workspace-1.note.md',
    ensureStatusWidgetSupport: async () => ({
      configurationPath: '/state/status-plugins.json',
      guidePath: '/state/agent-guides/status-widget.md',
      validatorPath: '/state/agent-guides/validate-status-widgets.mjs',
      validationCommand: "node '/state/agent-guides/validate-status-widgets.mjs' '/state/status-plugins.json'",
    }),
    queuePrompt: async (_workspaceId, input, now) => queuedAutomation(input.actionId, input.prompt, now ?? 0),
    ...overrides,
  };
}

test('describes the exact note path and queues a minimal visible prompt', async () => {
  const queued: Array<{ workspaceId: string; actionId: string; prompt: string }> = [];
  const support = dependencies({
    queuePrompt: async (workspaceId, input, now) => {
      queued.push({ workspaceId, actionId: input.actionId, prompt: input.prompt });
      return queuedAutomation(input.actionId, input.prompt, now ?? 0);
    },
  });
  const descriptor = await describeWorkspaceAgentAction('workspace-1', 'note', support);
  assert.deepEqual(descriptor.target, {
    workspaceId: 'workspace-1',
    workspaceLabel: 'Project',
    agentLabel: 'codex',
  });
  assert.equal(descriptor.context[0]?.value, '/state/workspace-1.note.md');

  const submission = await queueWorkspaceAgentAction(
    'workspace-1',
    'note',
    'Organize the blocker and next step.',
    1_000,
    support
  );
  assert.equal(submission.status, 'queued');
  assert.deepEqual(queued, [
    {
      workspaceId: 'workspace-1',
      actionId: 'note',
      prompt: [
        'Vampire workspace note: "/state/workspace-1.note.md"',
        '',
        'User request:',
        'Organize the blocker and next step.',
      ].join('\n'),
    },
  ]);
  assert.doesNotMatch(submission.prompt, /preserve|do not edit|level-two headings/i);
});

test('supplies the current widget configuration, guide, and validator to the main agent', async () => {
  const descriptor = await describeWorkspaceAgentAction('workspace-1', 'status-widget', dependencies());
  assert.deepEqual(
    descriptor.context.map((item) => item.value),
    [
      '/state/status-plugins.json',
      '/state/agent-guides/status-widget.md',
      "node '/state/agent-guides/validate-status-widgets.mjs' '/state/status-plugins.json'",
    ]
  );

  const submission = await queueWorkspaceAgentAction(
    'workspace-1',
    'status-widget',
    'Show unread GitHub notifications.',
    2_000,
    dependencies()
  );
  assert.match(submission.prompt, /status-plugins\.json/);
  assert.match(submission.prompt, /status-widget\.md/);
  assert.match(submission.prompt, /validate-status-widgets\.mjs/);
  assert.match(submission.prompt, /Show unread GitHub notifications\./);
});

test('rejects stopped, shell-only, and empty agent requests before queuing', async () => {
  const stopped = workspace();
  stopped.state = 'missing';
  await assert.rejects(
    describeWorkspaceAgentAction('workspace-1', 'note', dependencies({ findWorkspace: async () => stopped })),
    (error) => error instanceof WorkspaceAgentActionError && error.reason === 'not-running'
  );

  const shellOnly = workspace();
  shellOnly.terminals[0]!.foregroundProcess = { kind: 'shell', label: 'zsh' };
  await assert.rejects(
    describeWorkspaceAgentAction('workspace-1', 'note', dependencies({ findWorkspace: async () => shellOnly })),
    (error) => error instanceof WorkspaceAgentActionError && error.reason === 'no-agent'
  );

  await assert.rejects(
    queueWorkspaceAgentAction('workspace-1', 'note', '   ', 1, dependencies()),
    (error) => error instanceof WorkspaceAgentActionError && error.reason === 'invalid-request'
  );
});
