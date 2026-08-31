import { findManagedWorkspace, type ManagedWorkspace } from './workspace-registry.server.ts';
import {
  ensureManagedWorkspaceNoteFile,
  managedWorkspaceNotePath,
} from '~/lib/features/workspace/server/workspace-note-file.server.ts';
import { queueManagedWorkspaceAgentPrompt } from '~/lib/features/workspace/server/workspace-automations.server.ts';
import { ensureStatusWidgetAgentSupport } from '~/lib/features/status/server/status-widget-agent-support.server.ts';
import {
  assertWorkspaceAutomationAgentCapacity,
  discardWorkspaceAutomationAgentSupport,
  reserveWorkspaceAutomationAgentSupport,
} from '~/lib/features/workspace/server/workspace-automation-agent-support.server.ts';
import { isAgentProcessLabel } from '~/lib/shared/contracts/workspace-agent.ts';
import {
  WORKSPACE_AGENT_ACTION_REQUEST_MAX_LENGTH,
  type WorkspaceAgentActionDescriptor,
  type WorkspaceAgentActionId,
  type WorkspaceAgentActionSubmission,
} from '~/lib/shared/contracts/workspace-agent-actions.ts';

export type WorkspaceAgentActionErrorReason =
  | 'not-found'
  | 'not-running'
  | 'no-agent'
  | 'invalid-request'
  | 'unsupported-action';

export class WorkspaceAgentActionError extends Error {
  readonly reason: WorkspaceAgentActionErrorReason;

  constructor(reason: WorkspaceAgentActionErrorReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

type AgentTarget = {
  workspaceId: string;
  workspaceLabel: string;
  agentLabel: string;
};

type PreparedAgentAction = {
  descriptor: WorkspaceAgentActionDescriptor;
  name: string;
  prompt: (request: string) => string;
  discard?: () => Promise<void>;
};

type PrepareAgentAction = (
  target: AgentTarget,
  dependencies: WorkspaceAgentActionDependencies,
  materialize: boolean
) => Promise<PreparedAgentAction>;

export type WorkspaceAgentActionDependencies = {
  findWorkspace: typeof findManagedWorkspace;
  ensureNoteFile: typeof ensureManagedWorkspaceNoteFile;
  notePath: typeof managedWorkspaceNotePath;
  ensureStatusWidgetSupport: typeof ensureStatusWidgetAgentSupport;
  ensureAutomationSupport: typeof reserveWorkspaceAutomationAgentSupport;
  assertAutomationCapacity: typeof assertWorkspaceAutomationAgentCapacity;
  queuePrompt: typeof queueManagedWorkspaceAgentPrompt;
};

const defaultDependencies: WorkspaceAgentActionDependencies = {
  findWorkspace: findManagedWorkspace,
  ensureNoteFile: ensureManagedWorkspaceNoteFile,
  notePath: managedWorkspaceNotePath,
  ensureStatusWidgetSupport: ensureStatusWidgetAgentSupport,
  ensureAutomationSupport: reserveWorkspaceAutomationAgentSupport,
  assertAutomationCapacity: assertWorkspaceAutomationAgentCapacity,
  queuePrompt: queueManagedWorkspaceAgentPrompt,
};

function workspaceLabel(workspace: ManagedWorkspace): string {
  return workspace.workspaceLabel?.trim() || workspace.cwd;
}

function mainAgentLabel(workspace: ManagedWorkspace): string | undefined {
  const mainTerminal = workspace.terminals.find((terminal) => terminal.index === 0);
  if (mainTerminal?.state !== 'running') return undefined;
  const process = mainTerminal?.foregroundProcess;
  if (process?.kind !== 'command' || !isAgentProcessLabel(process.label)) return undefined;
  return process.label;
}

async function requireAgentTarget(
  workspaceId: string,
  dependencies: WorkspaceAgentActionDependencies
): Promise<AgentTarget> {
  const workspace = await dependencies.findWorkspace(workspaceId);
  if (!workspace) throw new WorkspaceAgentActionError('not-found', 'Workspace was not found.');
  if (workspace.state !== 'running') {
    throw new WorkspaceAgentActionError('not-running', 'Open this workspace before asking its agent.');
  }
  const agentLabel = mainAgentLabel(workspace);
  if (!agentLabel) {
    throw new WorkspaceAgentActionError(
      'no-agent',
      'Start a supported agent in the main terminal before using Ask agent.'
    );
  }
  return {
    workspaceId: workspace.id,
    workspaceLabel: workspaceLabel(workspace),
    agentLabel,
  };
}

function notePrompt(notePath: string, request: string): string {
  return [`Vampire workspace note: ${JSON.stringify(notePath)}`, '', 'User request:', request].join('\n');
}

async function prepareNoteAction(
  target: AgentTarget,
  dependencies: WorkspaceAgentActionDependencies
): Promise<PreparedAgentAction> {
  await dependencies.ensureNoteFile(target.workspaceId, '');
  const notePath = dependencies.notePath(target.workspaceId);
  return {
    descriptor: {
      id: 'note',
      title: 'Ask agent about this note',
      description: 'The note path is supplied as context. You decide how the agent should read or update it.',
      target,
      context: [{ label: 'Workspace note', value: notePath }],
      requestLabel: 'What should the agent do?',
      requestPlaceholder: 'For example: organize the important context and next steps.',
      defaultRequest:
        'Review the current workspace state and organize this note with the important context and next steps.',
    },
    name: 'Workspace note request',
    prompt: (request) => notePrompt(notePath, request),
  };
}

function statusWidgetPrompt(
  support: Awaited<ReturnType<typeof ensureStatusWidgetAgentSupport>>,
  request: string
): string {
  return [
    'Create or update a Vampire status widget using the supported files below.',
    '',
    `Configuration: ${JSON.stringify(support.configurationPath)}`,
    `Current guide: ${JSON.stringify(support.guidePath)}`,
    `Validation command: ${support.validationCommand}`,
    '',
    'Read the current guide and configuration, preserve unrelated widgets, implement the request, and run the validator.',
    '',
    'User request:',
    request,
  ].join('\n');
}

async function prepareStatusWidgetAction(
  target: AgentTarget,
  dependencies: WorkspaceAgentActionDependencies
): Promise<PreparedAgentAction> {
  const support = await dependencies.ensureStatusWidgetSupport();
  return {
    descriptor: {
      id: 'status-widget',
      title: 'Create a status widget with an agent',
      description: 'Vampire supplies its live configuration, current widget contract, and validator.',
      target,
      context: [
        {
          label: 'Widget configuration',
          value: support.configurationPath,
          description: 'The running server detects valid changes automatically.',
        },
        {
          label: 'Widget guide',
          value: support.guidePath,
          description: 'This file is refreshed by the installed Vampire version.',
        },
        { label: 'Validation command', value: support.validationCommand },
      ],
      requestLabel: 'What widget should the agent create?',
      requestPlaceholder: 'For example: show unread GitHub notifications and link to the notifications page.',
      defaultRequest: '',
    },
    name: 'Status widget request',
    prompt: (request) => statusWidgetPrompt(support, request),
  };
}

function automationPrompt(
  support: Awaited<ReturnType<typeof reserveWorkspaceAutomationAgentSupport>>,
  request: string
): string {
  return [
    'Create one Vampire workspace automation using the supported request files below.',
    '',
    `Draft request: ${JSON.stringify(support.requestPath)}`,
    `Current guide: ${JSON.stringify(support.guidePath)}`,
    `Apply command: ${support.applyCommand}`,
    '',
    'Read the guide, edit only the supplied draft, run the apply command, and report the automation you staged.',
    '',
    'User request:',
    request,
  ].join('\n');
}

async function prepareAutomationAction(
  target: AgentTarget,
  dependencies: WorkspaceAgentActionDependencies,
  materialize: boolean
): Promise<PreparedAgentAction> {
  if (!materialize) await dependencies.assertAutomationCapacity(target.workspaceId);
  const support = materialize ? await dependencies.ensureAutomationSupport(target.workspaceId) : undefined;
  return {
    descriptor: {
      id: 'automation',
      title: 'Create an automation with an agent',
      description:
        'Vampire supplies an isolated request file, the current schedule contract, and a safe apply command.',
      target,
      context: support
        ? [
            { label: 'Automation request', value: support.requestPath },
            { label: 'Automation guide', value: support.guidePath },
            { label: 'Apply command', value: support.applyCommand },
          ]
        : [
            {
              label: 'Agent support',
              value: 'Prepared when sent',
              description: 'Vampire creates an isolated request, the current schedule guide, and a safe apply command.',
            },
          ],
      requestLabel: 'What should the automation do, and when?',
      requestPlaceholder: 'For example: every weekday at 9 AM, review open work and continue the next useful task.',
      defaultRequest: '',
    },
    name: 'Workspace automation request',
    prompt: (request) => {
      if (!support) throw new Error('Automation agent support was not prepared.');
      return automationPrompt(support, request);
    },
    ...(support ? { discard: () => discardWorkspaceAutomationAgentSupport(support) } : {}),
  };
}

const AGENT_ACTION_PREPARERS = {
  note: prepareNoteAction,
  'status-widget': prepareStatusWidgetAction,
  automation: prepareAutomationAction,
} satisfies Record<WorkspaceAgentActionId, PrepareAgentAction>;

async function prepareAgentAction(
  workspaceId: string,
  actionId: WorkspaceAgentActionId,
  dependencies: WorkspaceAgentActionDependencies,
  materialize = false
): Promise<PreparedAgentAction> {
  const target = await requireAgentTarget(workspaceId, dependencies);
  const prepare = AGENT_ACTION_PREPARERS[actionId];
  if (!prepare) throw new WorkspaceAgentActionError('unsupported-action', 'Agent action is not supported.');
  return prepare(target, dependencies, materialize);
}

function normalizeRequest(value: unknown): string {
  const request = typeof value === 'string' ? value.trim() : '';
  if (!request || request.length > WORKSPACE_AGENT_ACTION_REQUEST_MAX_LENGTH || request.includes('\0')) {
    throw new WorkspaceAgentActionError(
      'invalid-request',
      `Agent requests must be between 1 and ${WORKSPACE_AGENT_ACTION_REQUEST_MAX_LENGTH.toLocaleString('en-US')} characters.`
    );
  }
  return request;
}

export async function describeWorkspaceAgentAction(
  workspaceId: string,
  actionId: WorkspaceAgentActionId,
  dependencies: WorkspaceAgentActionDependencies = defaultDependencies
): Promise<WorkspaceAgentActionDescriptor> {
  return (await prepareAgentAction(workspaceId, actionId, dependencies)).descriptor;
}

export async function queueWorkspaceAgentAction(
  workspaceId: string,
  actionId: WorkspaceAgentActionId,
  value: unknown,
  now = Date.now(),
  dependencies: WorkspaceAgentActionDependencies = defaultDependencies
): Promise<WorkspaceAgentActionSubmission> {
  const request = normalizeRequest(value);
  const action = await prepareAgentAction(workspaceId, actionId, dependencies, true);
  const prompt = action.prompt(request);
  try {
    await dependencies.queuePrompt(
      workspaceId,
      {
        actionId,
        name: action.name,
        prompt,
      },
      now
    );
  } catch (error) {
    await action.discard?.().catch(() => undefined);
    throw error;
  }
  return { actionId, status: 'queued', queuedAt: now, prompt };
}
