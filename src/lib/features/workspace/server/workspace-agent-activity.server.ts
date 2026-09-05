import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { tmuxCommandArguments } from '~/lib/server/tmux-command.ts';
import { mainWorkspacePromptTarget, type AgentState } from '~/lib/shared/contracts/workspace-agent.ts';

type ForegroundProcess = {
  kind: 'shell' | 'command';
  label: string;
};

type AgentWorkspace = {
  id: string;
  state: 'running' | 'missing';
  terminals?: Array<{
    id: string;
    index: number;
    state: 'running' | 'exited';
    foregroundProcess?: ForegroundProcess | null;
  }>;
};

const execFile = promisify(execFileCallback);
const RECENT_SCREEN_LINES = 14;

// Infer only the coarse turn boundary. Terminal content is neither retained
// nor returned to callers.
export function inferAgentState(process: ForegroundProcess | null | undefined, output: string): AgentState {
  if (process?.kind !== 'command') return null;
  const recentLines = output.replace(/\r/g, '').split('\n').slice(-RECENT_SCREEN_LINES);
  const recent = recentLines.join('\n');

  // Some agent TUIs leave their composer visible while working, so the
  // interrupt hint must take precedence over detecting an input prompt.
  if (/(?:esc|escape)\s+to\s+(?:interrupt|cancel)/i.test(recent)) return 'working';
  if (/press\s+(?:esc|escape).{0,24}(?:interrupt|cancel)/i.test(recent)) return 'working';

  const promptPattern = /^\s*[❯›>](?:\s|$)/;
  return recentLines.some((line) => promptPattern.test(line)) ? 'waiting' : null;
}

export async function readWorkspaceAgentStates(workspaces: Iterable<AgentWorkspace>): Promise<Map<string, AgentState>> {
  const states = new Map<string, AgentState>();
  const captures: Promise<void>[] = [];
  for (const workspace of workspaces) {
    states.set(workspace.id, null);
    const mainTerminal = workspace.terminals?.find((terminal) => terminal.index === 0);
    const process = mainWorkspacePromptTarget(workspace);
    if (!mainTerminal || !/^@\d+$/.test(mainTerminal.id) || !process) continue;

    captures.push(
      (async () => {
        try {
          const { stdout } = await execFile(
            'tmux',
            tmuxCommandArguments(['capture-pane', '-p', '-S', `-${RECENT_SCREEN_LINES}`, '-t', mainTerminal.id]),
            { maxBuffer: 128 * 1024, timeout: 750 }
          );
          states.set(workspace.id, inferAgentState(process, stdout));
        } catch {
          // Unknown falls back to output timing; a capture failure must not
          // disrupt workspace updates.
        }
      })()
    );
  }
  await Promise.all(captures);
  return states;
}
