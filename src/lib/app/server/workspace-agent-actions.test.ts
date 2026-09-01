import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkspaceAutomation } from '~/lib/shared/contracts/workspace-automations.ts';
import { WorkspaceAutomationMutationError } from '~/lib/features/workspace/server/workspace-automations.server.ts';
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
    composerPromptPreview: null,
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

function queuedAutomation(
  actionId: 'note' | 'status-widget' | 'automation',
  prompt: string,
  now: number
): WorkspaceAutomation {
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
    ensureAutomationSupport: async () => ({
      requestPath: '/state/automation-requests/workspace-1.draft.json',
      guidePath: '/state/agent-guides/workspace-automation.md',
      applyPath: '/state/agent-guides/apply-workspace-automation.mjs',
      applyCommand:
        "node '/state/agent-guides/apply-workspace-automation.mjs' '/state/automation-requests/workspace-1.draft.json' '/state/automation-requests/workspace-1.ready.json'",
    }),
    assertAutomationCapacity: async () => undefined,
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

test('supplies an isolated automation management request, guide, and apply command to the main agent', async () => {
  const descriptor = await describeWorkspaceAgentAction('workspace-1', 'automation', dependencies());
  assert.equal(descriptor.title, 'Manage automations with an agent');
  assert.equal(descriptor.requestLabel, 'What should the agent create or change?');
  assert.deepEqual(
    descriptor.context.map((item) => item.value),
    ['Prepared when sent']
  );

  const submission = await queueWorkspaceAgentAction(
    'workspace-1',
    'automation',
    'Every weekday at 9 AM, review open work.',
    3_000,
    dependencies()
  );
  assert.match(submission.prompt, /Create or update one Vampire workspace automation/);
  assert.match(submission.prompt, /currentAutomations snapshot/);
  assert.match(submission.prompt, /workspace-automation\.md/);
  assert.match(submission.prompt, /apply-workspace-automation\.mjs/);
  assert.match(submission.prompt, /Every weekday at 9 AM/);
});

test('materializes automation support only when the request is submitted', async () => {
  let materializations = 0;
  const support = dependencies({
    ensureAutomationSupport: async () => {
      materializations += 1;
      return {
        requestPath: '/state/automation-requests/request.draft.json',
        guidePath: '/state/agent-guides/workspace-automation.md',
        applyPath: '/state/agent-guides/apply-workspace-automation.mjs',
        applyCommand: "node 'apply' 'draft' 'ready'",
      };
    },
  });
  await describeWorkspaceAgentAction('workspace-1', 'automation', support);
  assert.equal(materializations, 0);
  await queueWorkspaceAgentAction('workspace-1', 'automation', 'Create a daily review.', 4_000, support);
  assert.equal(materializations, 1);
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

test('rejects automation agent requests before queuing when pending request capacity is full', async () => {
  await assert.rejects(
    describeWorkspaceAgentAction(
      'workspace-1',
      'automation',
      dependencies({
        assertAutomationCapacity: async () => {
          throw new WorkspaceAutomationMutationError(
            'limit',
            'A workspace can have up to 32 pending automation agent requests.'
          );
        },
      })
    ),
    (error) => error instanceof WorkspaceAutomationMutationError && error.reason === 'limit'
  );
});
