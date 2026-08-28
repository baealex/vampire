export type AgentState = 'working' | 'waiting' | null;

const AGENT_PROCESS_LABELS = new Set(['aider', 'claude', 'claude-code', 'codex', 'gemini', 'opencode']);

type AgentProcess = { kind: 'shell' | 'command'; label: string };

type AgentWorkspace = {
  state: 'running' | 'missing';
  foregroundProcess?: AgentProcess | null;
  terminals?: Array<{
    terminalKind?: 'main' | 'background' | 'king-task';
    foregroundProcess?: AgentProcess | null;
    state?: 'running' | 'exited';
  }>;
};

export function isAgentProcessLabel(label: string): boolean {
  return AGENT_PROCESS_LABELS.has(label.trim().toLowerCase());
}

export function workspaceHasRecognizedMainAgent(workspace: AgentWorkspace): boolean {
  if (workspace.state !== 'running') return false;
  const mainTerminal =
    workspace.terminals?.find((terminal) => terminal.terminalKind === 'main') ??
    workspace.terminals?.find((terminal) => terminal.terminalKind === undefined);
  if (mainTerminal?.state === 'exited') return false;
  const process = mainTerminal ? mainTerminal.foregroundProcess : workspace.foregroundProcess;
  return process?.kind === 'command' && isAgentProcessLabel(process.label);
}
