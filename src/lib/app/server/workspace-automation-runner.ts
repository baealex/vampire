import { readWorkspaceAgentStates } from '~/lib/features/workspace/server/workspace-agent-activity.ts';
import {
  dispatchManagedWorkspaceAutomation,
  listDueManagedWorkspaceAutomations,
  migrateManagedWorkspaceNotes,
} from '~/lib/features/workspace/server/workspace-automations.ts';
import type { StoredWorkspace } from '~/lib/features/workspace/server/workspace-store.ts';
import {
  listTmuxSessions,
  submitTmuxPrompt,
  type TmuxSession,
  type TmuxTerminal,
} from '~/lib/features/terminal/server/tmux.ts';
import { isAgentProcessLabel, type AgentState } from '~/lib/shared/contracts/workspace-agent.ts';
import type { WorkspaceAutomation } from '~/lib/shared/contracts/workspace-automations.ts';

const AUTOMATION_POLL_INTERVAL_MS = 2_000;

export function automationSubmissionTerminal(
  tmuxSession: TmuxSession | undefined,
  agentState: AgentState
): TmuxTerminal | undefined {
  const mainTerminal = tmuxSession?.terminals[0];
  const process = mainTerminal?.foregroundProcess;
  return agentState === 'waiting' &&
    mainTerminal?.index === 0 &&
    mainTerminal.state === 'running' &&
    process?.kind === 'command' &&
    isAgentProcessLabel(process.label)
    ? mainTerminal
    : undefined;
}

type AutomationSubmissionDependencies = {
  listTmuxSessions: typeof listTmuxSessions;
  readAgentStates: typeof readWorkspaceAgentStates;
  submitPrompt: typeof submitTmuxPrompt;
};

const submissionDependencies: AutomationSubmissionDependencies = {
  listTmuxSessions,
  readAgentStates: readWorkspaceAgentStates,
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
  const detected = await dependencies.readAgentStates([
    {
      id: stored.id,
      state: 'running',
      terminals: running.terminals,
    },
  ]);
  const terminal = automationSubmissionTerminal(running, detected.get(stored.id) ?? null);
  if (!terminal) return undefined;
  return () => dependencies.submitPrompt(stored.tmuxSession, terminal.id, automation.prompt);
}

export async function runWorkspaceAutomationTick(now = Date.now()): Promise<void> {
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
  let noteMigrationComplete = false;
  const attemptNoteMigration = async () => {
    if (noteMigrationComplete) return;
    try {
      await migrateManagedWorkspaceNotes();
      noteMigrationComplete = true;
    } catch {
      // Retry the migration on the next automation tick without falling back
      // to the compatibility JSON note.
    }
  };
  await attemptNoteMigration();
  let activeTick: Promise<void> | undefined;
  const tick = () => {
    if (activeTick) return;
    activeTick = attemptNoteMigration()
      .then(() => runWorkspaceAutomationTick())
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
