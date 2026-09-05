export type AgentState = 'working' | 'waiting' | null;

export type WorkspacePromptTargetProcess = {
  kind: 'shell' | 'command';
  label: string;
};

type WorkspacePromptTarget = {
  state: 'running' | 'missing';
  terminals?: Array<{
    index: number;
    state: 'running' | 'exited';
    foregroundProcess?: WorkspacePromptTargetProcess | null;
  }>;
};

export function mainWorkspacePromptTarget(workspace: WorkspacePromptTarget): WorkspacePromptTargetProcess | null {
  if (workspace.state !== 'running') return null;
  const mainTerminal = workspace.terminals?.find((terminal) => terminal.index === 0);
  if (!mainTerminal || mainTerminal.state !== 'running') return null;
  const process = mainTerminal.foregroundProcess;
  return process?.kind === 'command' && process.label.trim() ? process : null;
}
