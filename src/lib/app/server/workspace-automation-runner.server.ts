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
import { isAgentProcessLabel } from '~/lib/shared/contracts/workspace-agent.ts';
import type { WorkspaceAutomation } from '~/lib/shared/contracts/workspace-automations.ts';
import { importWorkspaceAutomationAgentRequests } from '~/lib/features/workspace/server/workspace-automation-agent-support.server.ts';

const AUTOMATION_POLL_INTERVAL_MS = 2_000;

export function automationSubmissionTerminal(tmuxSession: TmuxSession | undefined): TmuxTerminal | undefined {
  const mainTerminal = tmuxSession?.terminals[0];
  const process = mainTerminal?.foregroundProcess;
  return mainTerminal?.index === 0 &&
    mainTerminal.state === 'running' &&
    process?.kind === 'command' &&
    isAgentProcessLabel(process.label)
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

export async function runWorkspaceAutomationTick(now = Date.now()): Promise<void> {
  await importWorkspaceAutomationAgentRequests();
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
      // One unreadable workspace must not stop other users' queued automations.
    }
  }
}

export async function installWorkspaceAutomationRunner(): Promise<() => void> {
  await migrateManagedWorkspaceComposerHistories();
  await migrateManagedWorkspaceNotes();
  let activeTick: Promise<void> | undefined;
  const tick = () => {
    if (activeTick) return;
    activeTick = runWorkspaceAutomationTick()
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
