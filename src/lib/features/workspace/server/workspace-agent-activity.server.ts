import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { isAgentProcessLabel, type AgentState } from '~/lib/shared/contracts/workspace-agent.ts';

type ForegroundProcess = {
  kind: 'shell' | 'command';
  label: string;
};

type AgentWorkspace = {
  id: string;
  state: 'running' | 'missing';
  terminals?: Array<{
    id: string;
    foregroundProcess?: ForegroundProcess | null;
    terminalKind?: 'main' | 'background' | 'king-task';
  }>;
};

type AgentTerminal = NonNullable<AgentWorkspace['terminals']>[number];

const execFile = promisify(execFileCallback);
const RECENT_SCREEN_LINES = 14;

export { isAgentProcessLabel };

function agentPromptPattern(label: string): RegExp {
  if (label === 'codex') return /^\s*›(?:\s|$)/;
  if (label === 'claude' || label === 'claude-code') return /^\s*❯(?:\s|$)/;
  return /^\s*[❯›>](?:\s|$)/;
}

function workspaceMainTerminal(workspace: AgentWorkspace): AgentTerminal | undefined {
  const terminals = workspace.terminals;
  return (
    terminals?.find((terminal) => terminal.terminalKind === 'main') ??
    terminals?.find((terminal) => terminal.terminalKind === undefined)
  );
}

function recentMeaningfulScreenLines(output: string): string[] {
  const lines = output.replace(/\r/g, '').split('\n');
  while (lines.length > 0 && (lines.at(-1) ?? '').trim().length === 0) lines.pop();
  return lines.slice(-RECENT_SCREEN_LINES);
}

// Infer only the coarse turn boundary. Terminal content is neither retained
// nor returned to callers.
export function inferAgentState(process: ForegroundProcess | null | undefined, output: string): AgentState {
  if (process?.kind !== 'command' || !isAgentProcessLabel(process.label)) return null;
  const label = process.label.toLowerCase();
  const recentLines = recentMeaningfulScreenLines(output);
  const recent = recentLines.join('\n');

  // Some agent TUIs leave their composer visible while working, so the
  // interrupt hint must take precedence over detecting an input prompt.
  if (/(?:esc|escape)\s+to\s+(?:interrupt|cancel)/i.test(recent)) return 'working';
  if (/press\s+(?:esc|escape).{0,24}(?:interrupt|cancel)/i.test(recent)) return 'working';

  const promptPattern = agentPromptPattern(label);
  return recentLines.some((line) => promptPattern.test(line)) ? 'waiting' : null;
}

export async function readTerminalAgentState(terminal: AgentTerminal | undefined): Promise<AgentState> {
  const process = terminal?.foregroundProcess;
  if (!terminal || !/^@\d+$/.test(terminal.id) || process?.kind !== 'command' || !isAgentProcessLabel(process.label)) {
    return null;
  }
  try {
    const { stdout } = await execFile(
      'tmux',
      ['capture-pane', '-p', '-S', `-${RECENT_SCREEN_LINES}`, '-t', terminal.id],
      { maxBuffer: 128 * 1024, timeout: 750 }
    );
    return inferAgentState(process, stdout);
  } catch {
    return null;
  }
}

export async function readWorkspaceAgentStates(workspaces: Iterable<AgentWorkspace>): Promise<Map<string, AgentState>> {
  const states = new Map<string, AgentState>();
  const captures: Promise<void>[] = [];
  for (const workspace of workspaces) {
    states.set(workspace.id, null);
    const mainTerminal = workspaceMainTerminal(workspace);
    if (workspace.state !== 'running' || !mainTerminal) continue;

    captures.push(
      (async () => {
        states.set(workspace.id, await readTerminalAgentState(mainTerminal));
      })()
    );
  }
  await Promise.all(captures);
  return states;
}
