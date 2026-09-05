import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
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
const CAPTURE_BATCH_SIZE = 16;

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

type CaptureTarget = {
  workspaceId: string;
  terminalId: string;
  process: ForegroundProcess;
};

function captureArguments(terminalId: string): string[] {
  return ['capture-pane', '-p', '-S', `-${RECENT_SCREEN_LINES}`, '-t', terminalId];
}

async function captureBatch(targets: CaptureTarget[]): Promise<Array<string | undefined>> {
  // A random delimiter keeps terminal content separate without interpreting it.
  const marker = `vampire-capture-${randomUUID()}`;
  const args: string[] = [];
  for (const target of targets) {
    if (args.length) args.push(';');
    args.push(...captureArguments(target.terminalId), ';', 'display-message', '-p', marker);
  }
  try {
    const { stdout } = await execFile('tmux', tmuxCommandArguments(args), {
      maxBuffer: targets.length * 128 * 1024,
      timeout: 750,
    });
    const screens = stdout.split(`${marker}\n`);
    if (screens.length === targets.length + 1) return screens.slice(0, -1);
  } catch {
    // A window can disappear between polling and capture. tmux stops a command
    // list on failure, so retry individually to preserve the other windows' state.
  }
  return Promise.all(
    targets.map(async (target) => {
      try {
        const { stdout } = await execFile('tmux', tmuxCommandArguments(captureArguments(target.terminalId)), {
          maxBuffer: 128 * 1024,
          timeout: 750,
        });
        return stdout;
      } catch {
        return undefined;
      }
    })
  );
}

export async function readWorkspaceAgentStates(workspaces: Iterable<AgentWorkspace>): Promise<Map<string, AgentState>> {
  const states = new Map<string, AgentState>();
  const targets: CaptureTarget[] = [];
  for (const workspace of workspaces) {
    states.set(workspace.id, null);
    const mainTerminal = workspace.terminals?.find((terminal) => terminal.index === 0);
    const process = mainWorkspacePromptTarget(workspace);
    if (!mainTerminal || !/^@\d+$/.test(mainTerminal.id) || !process) continue;
    targets.push({ workspaceId: workspace.id, terminalId: mainTerminal.id, process });
  }

  for (let offset = 0; offset < targets.length; offset += CAPTURE_BATCH_SIZE) {
    const batch = targets.slice(offset, offset + CAPTURE_BATCH_SIZE);
    const screens = await captureBatch(batch);
    for (const [index, target] of batch.entries()) {
      const screen = screens[index];
      if (screen !== undefined) states.set(target.workspaceId, inferAgentState(target.process, screen));
    }
  }
  return states;
}
