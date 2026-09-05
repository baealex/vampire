import {
  dispatchManagedWorkspaceAutomation,
  listDueManagedWorkspaceAutomations,
  migrateManagedWorkspaceNotes,
} from '~/lib/features/workspace/server/workspace-automations.server.ts';
import type { StoredWorkspace } from '~/lib/features/workspace/server/workspace-store.server.ts';
import { migrateManagedWorkspaceComposerHistories } from '~/lib/features/workspace/server/workspace-composer-history.server.ts';
import {
  listTmuxSessions,
  submitTmuxPrompt,
  type TmuxSession,
  type TmuxTerminal,
} from '~/lib/features/terminal/server/tmux.server.ts';
import { mainWorkspacePromptTarget } from '~/lib/shared/contracts/workspace-agent.ts';
import type { WorkspaceAutomation } from '~/lib/shared/contracts/workspace-automations.ts';
import { importWorkspaceAutomationAgentRequests } from '~/lib/features/workspace/server/workspace-automation-agent-support.server.ts';
import { importWorkspaceBackgroundAgentRequests } from '~/lib/features/workspace/server/workspace-background-agent-support.server.ts';
import { automaticCommandsAllowed } from '~/lib/server/runtime-safety.ts';

const AUTOMATION_POLL_INTERVAL_MS = 2_000;

export function automationSubmissionTerminal(tmuxSession: TmuxSession | undefined): TmuxTerminal | undefined {
  const mainTerminal = tmuxSession?.terminals.find((terminal) => terminal.index === 0);
  return tmuxSession && mainTerminal && mainWorkspacePromptTarget({ state: 'running', ...tmuxSession })
    ? mainTerminal
    : undefined;
}

type AutomationSubmissionDependencies = {
  listTmuxSessions: typeof listTmuxSessions;
  submitPrompt: typeof submitTmuxPrompt;
};

const submissionDependencies: AutomationSubmissionDependencies = {
  listTmuxSessions,
  submitPrompt: submitTmuxPrompt,
};

export async function prepareAutomationSubmission(
  stored: StoredWorkspace,
  automation: WorkspaceAutomation,
  dependencies: AutomationSubmissionDependencies = submissionDependencies
): Promise<(() => Promise<void>) | undefined> {
  const running = (await dependencies.listTmuxSessions()).find(
    (tmuxSession) => tmuxSession.name === stored.tmuxSession
  );
  if (!running) return undefined;
  const terminal = automationSubmissionTerminal(running);
  if (!terminal) return undefined;
  return () => dependencies.submitPrompt(stored.tmuxSession, terminal.id, automation.prompt);
}

export async function importWorkspaceAgentRequests(): Promise<void> {
  await importWorkspaceBackgroundAgentRequests();
  await importWorkspaceAutomationAgentRequests();
}

export async function runWorkspaceAutomationTick(now = Date.now()): Promise<void> {
  await importWorkspaceAgentRequests();
  const due = await listDueManagedWorkspaceAutomations(now);
  for (const candidate of due) {
    try {
      await dispatchManagedWorkspaceAutomation(
        candidate.workspaceId,
        candidate.automationId,
        now,
        (stored, automation) => prepareAutomationSubmission(stored, automation)
      );
    } catch {
      // One unreadable workspace must not stop other users' scheduled automations.
    }
  }
}

export async function installWorkspaceAutomationRunner(): Promise<() => void> {
  await migrateManagedWorkspaceComposerHistories();
  await migrateManagedWorkspaceNotes();
  const runTick = automaticCommandsAllowed() ? runWorkspaceAutomationTick : importWorkspaceAgentRequests;
  let activeTick: Promise<void> | undefined;
  const tick = () => {
    if (activeTick) return;
    activeTick = runTick()
      .catch(() => undefined)
      .finally(() => {
        activeTick = undefined;
      });
  };
  void tick();
  const timer = setInterval(tick, AUTOMATION_POLL_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
