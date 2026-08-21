export type AgentState = 'working' | 'waiting' | null;

const AGENT_PROCESS_LABELS = new Set(['aider', 'claude', 'claude-code', 'codex', 'gemini', 'opencode']);

export function isAgentProcessLabel(label: string): boolean {
  return AGENT_PROCESS_LABELS.has(label.trim().toLowerCase());
}
