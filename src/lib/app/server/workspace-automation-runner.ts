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
import { reconcileManagedKingWorkspaceContract } from '~/lib/features/workspace/server/king-workspace.ts';
import { withWorkspacePromptLock } from './workspace-prompt-lock.ts';

// Prompt submission still waits for an observed agent input prompt. A short
// cadence removes avoidable bootstrap lag without sending text into a shell or
// a TUI that is still starting; pane capture only happens while work is due.
const AUTOMATION_POLL_INTERVAL_MS = 500;

export function automationSubmissionTerminal(
  tmuxSession: TmuxSession | undefined,
  agentState: AgentState
): TmuxTerminal | undefined {
  const terminals = tmuxSession?.terminals;
  const mainTerminal =
    terminals?.find((terminal) => terminal.terminalKind === 'main') ??
    terminals?.find((terminal) => terminal.terminalKind === undefined);
  const process = mainTerminal?.foregroundProcess;
  if (agentState !== 'waiting') return undefined;
  if (!mainTerminal || mainTerminal.state !== 'running') return undefined;
  if (process?.kind !== 'command' || !isAgentProcessLabel(process.label)) return undefined;
  return mainTerminal;
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
      await withWorkspacePromptLock(candidate.workspaceId, () =>
        dispatchManagedWorkspaceAutomation(candidate.workspaceId, candidate.automationId, now, (stored, automation) =>
          prepareAutomationSubmission(stored, automation)
        )
      );
    } catch {
      // One unreadable workspace must not stop other users' queued automations.
    }
  }
}

export async function installWorkspaceAutomationRunner(): Promise<() => void> {
  let noteMigrationComplete = false;
  let kingContractReconciliationComplete = false;
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
  const attemptKingContractReconciliation = async () => {
    if (kingContractReconciliationComplete) return;
    try {
      await reconcileManagedKingWorkspaceContract();
      kingContractReconciliationComplete = true;
    } catch {
      // Retry after transient file or registry failures. The existing King
      // session remains usable with its last successfully installed contract.
    }
  };
  await Promise.all([attemptNoteMigration(), attemptKingContractReconciliation()]);
  let activeTick: Promise<void> | undefined;
  const tick = () => {
    if (activeTick) return;
    activeTick = Promise.all([attemptNoteMigration(), attemptKingContractReconciliation()])
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
