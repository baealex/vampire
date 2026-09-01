import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import type { TmuxStatus } from '~/lib/shared/contracts/tmux-status.ts';
import { terminalSubmissionData, terminalSubmissionSettleMs } from './submission.server.ts';
import { listProcesses, terminateProcessTrees, type ProcessRecord } from './process-cleanup.server.ts';

const execFile = promisify(execFileCallback);
const MAX_INPUT_BYTES = 64 * 1024;
const TMUX_WINDOW_FORMAT =
  '#{session_name}\t#{session_created}\t#{session_attached}\t#{window_index}\t#{window_id}\t#{window_name}\t#{window_active}\t#{window_activity}\t#{pane_id}\t#{pane_current_command}\t#{pane_pid}\t#{pane_title}\t#{@vampire_background_command}\t#{@vampire_background_started_at}\t#{pane_dead}\t#{pane_dead_status}';
const VAMPIRE_SERVER_ENVIRONMENT_KEYS = [
  'VAMPIRE_ADAPTER_BODY_SIZE_LIMIT',
  'VAMPIRE_ADAPTER_ORIGIN',
  'VAMPIRE_HOST',
  'VAMPIRE_PORT',
  'VAMPIRE_STATE_DIR',
  'VAMPIRE_TOKEN',
];

export function tmuxSessionLaunch(
  name: string,
  cwd: string,
  sourceEnvironment: NodeJS.ProcessEnv = process.env
): { arguments: string[]; environment: NodeJS.ProcessEnv } {
  const serverEnvironmentKeys = [
    ...new Set([
      ...VAMPIRE_SERVER_ENVIRONMENT_KEYS,
      ...Object.keys(sourceEnvironment).filter((key) => key.startsWith('VAMPIRE_')),
    ]),
  ].sort();
  const environment = { ...sourceEnvironment };
  for (const key of serverEnvironmentKeys) delete environment[key];

  return {
    arguments: [
      ...serverEnvironmentKeys.flatMap((key) => ['set-environment', '-gr', key, ';']),
      'new-session',
      '-d',
      '-s',
      name,
      '-c',
      cwd,
      '-P',
      '-F',
      TMUX_WINDOW_FORMAT,
    ],
    environment,
  };
}

function tmuxInstallGuide(): TmuxStatus['install'] {
  if (process.platform === 'darwin') {
    return {
      platform: 'macOS',
      commands: ['brew install tmux'],
      note: 'If Homebrew is not installed, install it from brew.sh first.',
    };
  }

  if (process.platform === 'linux') {
    return {
      platform: 'Linux',
      commands: [
        'sudo apt-get update && sudo apt-get install -y tmux',
        'sudo dnf install -y tmux',
        'sudo pacman -S tmux',
      ],
      note: 'Use the command matching your Linux distribution. Vampire does not run package managers or sudo automatically.',
    };
  }

  if (process.platform === 'win32') {
    return {
      platform: 'Windows',
      commands: ['wsl --install', 'sudo apt-get update && sudo apt-get install -y tmux'],
      note: 'Run the second command inside WSL, and run Vampire inside that WSL environment. Windows browsers can still connect to it.',
    };
  }

  return {
    platform: process.platform,
    commands: ['Install tmux with your operating system package manager.'],
    note: 'After installation, reload Vampire to check again.',
  };
}

export function isTmuxUnavailable(error: unknown): boolean {
  const details = error as NodeJS.ErrnoException & { stderr?: string };
  const output = `${details?.message ?? ''} ${details?.stderr ?? ''}`;
  return (
    details?.code === 'ENOENT' ||
    /(?:tmux|command) (?:not found|not recognized)/i.test(output) ||
    (Number(details?.code) === 1 &&
      /(?:no server running|error connecting to .*\(No such file or directory\))/i.test(output))
  );
}

export async function getTmuxStatus(): Promise<TmuxStatus> {
  try {
    const { stdout } = await execFile('tmux', ['-V'], { timeout: 2_000 });
    return { available: true, version: stdout.trim() || null, install: tmuxInstallGuide() };
  } catch {
    return { available: false, version: null, install: tmuxInstallGuide() };
  }
}

export interface TmuxSession {
  name: string;
  createdAt: number | null;
  lastOutputAt: number | null;
  attachedClients: number;
  foregroundProcess: TmuxProcessHint | null;
  terminals: TmuxTerminal[];
}

export interface TmuxSessionActivity {
  name: string;
  lastOutputAt: number | null;
  mainLastOutputAt: number | null;
}

export type TmuxProcessKind = 'shell' | 'command';

export interface TmuxProcessHint {
  kind: TmuxProcessKind;
  label: string;
}

export interface TmuxTerminal {
  id: string;
  index: number;
  name: string;
  active: boolean;
  lastOutputAt: number | null;
  foregroundProcess: TmuxProcessHint | null;
  command: string | null;
  startedAt: number | null;
  state: 'running' | 'exited';
  exitCode: number | null;
}

const SHELL_COMMANDS = new Set(['bash', 'dash', 'fish', 'ksh', 'nu', 'powershell', 'pwsh', 'sh', 'tcsh', 'zsh']);

function executableName(command: string): string {
  const executable = command.trim().split(/\s+/, 1)[0] ?? '';
  return executable.split('/').pop()?.replace(/^-/, '').toLowerCase() || '';
}

function foregroundProcessForPane(panePid: number, processes: Map<number, ProcessRecord>): ProcessRecord | undefined {
  const paneProcess = processes.get(panePid);
  let foregroundProcess = paneProcess?.tpgid ? processes.get(paneProcess.tpgid) : undefined;
  while (foregroundProcess && !SHELL_COMMANDS.has(executableName(foregroundProcess.command))) {
    const children = [...processes.values()].filter(
      (candidate) => candidate.ppid === foregroundProcess?.pid && candidate.tpgid === foregroundProcess?.tpgid
    );
    if (children.length !== 1) break;
    foregroundProcess = children[0];
  }
  return foregroundProcess;
}

function classifyProcess(
  currentCommand: string,
  title: string,
  panePid: number,
  processes: Map<number, ProcessRecord>
): TmuxProcessHint | null {
  if (!currentCommand && !title && panePid <= 0) return null;
  const foregroundProcess = foregroundProcessForPane(panePid, processes);
  const command = executableName(foregroundProcess?.command || currentCommand || title) || 'process';
  if (SHELL_COMMANDS.has(command.toLowerCase())) {
    return { kind: 'shell', label: command };
  }
  return { kind: 'command', label: command };
}

export async function createTmuxSession(name: string, cwd: string): Promise<TmuxSession> {
  const launch = tmuxSessionLaunch(name, cwd);
  const { stdout } = await execFile('tmux', launch.arguments, { env: launch.environment });
  const workspace = parseTmuxSessionsWithProcesses(stdout, new Map())[0];
  if (!workspace) throw new Error('tmux did not describe the new shell workspace.');
  return workspace;
}

function shellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function backgroundWindowName(command: string): string {
  return command.length > 48 ? `${command.slice(0, 47)}…` : command;
}

async function assertTmuxTerminalOwner(name: string, terminalId: string): Promise<void> {
  if (!/^@\d+$/.test(terminalId)) throw new Error('Terminal identifier is invalid.');
  const { stdout } = await execFile('tmux', ['display-message', '-p', '-t', terminalId, '#{session_name}'], {
    timeout: 3_000,
  });
  if (stdout.trim() !== name) throw new Error('Terminal does not belong to this workspace.');
}

function isMissingTmuxTarget(error: unknown): boolean {
  const details = error as NodeJS.ErrnoException & { stderr?: string };
  return (
    isTmuxUnavailable(error) ||
    (Number(details.code) === 1 && /can't find/i.test(details.stderr ?? details.message ?? ''))
  );
}

async function listTmuxPanePids(name: string, target: string, workspaceScope: boolean): Promise<number[]> {
  const { stdout } = await execFile(
    'tmux',
    ['list-panes', ...(workspaceScope ? ['-s'] : []), '-t', target, '-F', '#{session_name}\t#{pane_pid}'],
    { timeout: 3_000 }
  );
  const panePids = new Set<number>();
  for (const row of stdout.trim().split('\n').filter(Boolean)) {
    const [workspaceName, panePidValue] = row.split('\t');
    if (workspaceName !== name) throw new Error('tmux pane does not belong to this workspace.');
    const panePid = Number(panePidValue);
    if (Number.isInteger(panePid) && panePid > 1) panePids.add(panePid);
  }
  return [...panePids];
}

async function destroyTmuxTarget(arguments_: string[]): Promise<void> {
  try {
    await execFile('tmux', arguments_, { timeout: 3_000 });
  } catch (error) {
    if (isMissingTmuxTarget(error)) return;
    const target = arguments_.at(-1);
    if (target) {
      try {
        await execFile('tmux', ['display-message', '-p', '-t', target, '#{session_name}'], { timeout: 3_000 });
      } catch (verificationError) {
        const details = verificationError as NodeJS.ErrnoException;
        // A pane's foreground process can exit the final tmux session between
        // discovery and kill-session/kill-window. display-message returning 1
        // is authoritative confirmation that the requested target is gone.
        if (Number(details.code) === 1 || isMissingTmuxTarget(verificationError)) return;
      }
    }
    throw error;
  }
}

export async function createTmuxBackgroundProcess(name: string, cwd: string, command: string): Promise<TmuxTerminal> {
  const startedAt = Date.now();
  const { stdout } = await execFile('tmux', [
    'new-window',
    '-d',
    '-P',
    '-F',
    '#{window_id}',
    '-t',
    `${name}:`,
    '-c',
    cwd,
    '-n',
    backgroundWindowName(command),
  ]);
  const terminalId = stdout.trim();
  if (!/^@\d+$/.test(terminalId)) throw new Error('tmux did not describe the new background process.');

  try {
    await execFile('tmux', [
      'set-option',
      '-w',
      '-t',
      terminalId,
      'remain-on-exit',
      'on',
      ';',
      'set-option',
      '-w',
      '-t',
      terminalId,
      'automatic-rename',
      'off',
      ';',
      'set-option',
      '-w',
      '-t',
      terminalId,
      'allow-rename',
      'off',
      ';',
      'set-option',
      '-w',
      '-t',
      terminalId,
      '@vampire_background_command',
      command,
      ';',
      'set-option',
      '-w',
      '-t',
      terminalId,
      '@vampire_background_started_at',
      String(startedAt),
    ]);
    const shell = process.env.SHELL?.trim() || '/bin/sh';
    await execFile('tmux', [
      'respawn-pane',
      '-k',
      '-t',
      terminalId,
      `exec ${shellArgument(shell)} -lc ${shellArgument(command)}`,
    ]);
    const terminal = (await listTmuxSessions())
      .find((workspace) => workspace.name === name)
      ?.terminals.find((candidate) => candidate.id === terminalId);
    if (!terminal) throw new Error('tmux did not describe the new background process.');
    return terminal;
  } catch (error) {
    await execFile('tmux', ['kill-window', '-t', terminalId]).catch(() => undefined);
    throw error;
  }
}

export async function killTmuxBackgroundProcess(name: string, terminalId: string): Promise<void> {
  try {
    await assertTmuxTerminalOwner(name, terminalId);
    const panePids = await listTmuxPanePids(name, terminalId, false);
    await terminateProcessTrees(panePids, () => destroyTmuxTarget(['kill-window', '-t', terminalId]));
  } catch (error) {
    if (isMissingTmuxTarget(error)) return;
    throw error;
  }
}

export function stripTmuxCapturePadding(output: string): string {
  const lines = output.split('\n');
  while (lines.length > 0 && (lines.at(-1) ?? '').trim().length === 0) lines.pop();
  return lines.join('\n');
}

export async function captureTmuxBackgroundOutput(name: string, terminalId: string): Promise<string> {
  await assertTmuxTerminalOwner(name, terminalId);
  const { stdout } = await execFile('tmux', ['capture-pane', '-p', '-S', '-', '-t', terminalId], {
    maxBuffer: 512 * 1024,
    timeout: 3_000,
  });
  return stripTmuxCapturePadding(stdout);
}

export async function sendTmuxInput(name: string, data: string): Promise<void> {
  if (Buffer.byteLength(data) > MAX_INPUT_BYTES) throw new Error('Input is too large.');
  await execFile('tmux', ['send-keys', '-t', name, '-l', '--', data]);
}

export function tmuxPromptSubmissionArguments(terminalId: string, data: string, bracketedPaste: boolean): string[] {
  if (!/^@\d+$/.test(terminalId)) throw new Error('Terminal identifier is invalid.');
  if (Buffer.byteLength(data) > MAX_INPUT_BYTES) throw new Error('Input is too large.');
  // Without bracketed paste, CR/LF is indistinguishable from Enter to a TUI.
  // Collapse multiline prompts so an automation always submits exactly once.
  const submission = bracketedPaste ? terminalSubmissionData(data, true) : data.replace(/\r?\n|\r/g, ' ');
  return ['send-keys', '-t', terminalId, '-l', '--', submission];
}

export function tmuxPromptEnterArguments(terminalId: string): string[] {
  if (!/^@\d+$/.test(terminalId)) throw new Error('Terminal identifier is invalid.');
  return ['send-keys', '-t', terminalId, 'Enter'];
}

export async function submitTmuxPrompt(name: string, terminalId: string, data: string): Promise<void> {
  await assertTmuxTerminalOwner(name, terminalId);
  const { stdout } = await execFile('tmux', ['display-message', '-p', '-t', terminalId, '#{bracket_paste_flag}'], {
    timeout: 3_000,
  });
  const bracketedPaste = stdout.trim() === '1';
  await execFile('tmux', tmuxPromptSubmissionArguments(terminalId, data, bracketedPaste), { timeout: 5_000 });
  await new Promise((resolve) => setTimeout(resolve, terminalSubmissionSettleMs(bracketedPaste)));
  await execFile('tmux', tmuxPromptEnterArguments(terminalId), { timeout: 3_000 });
}

export async function killTmuxSession(name: string): Promise<void> {
  try {
    const panePids = await listTmuxPanePids(name, name, true);
    await terminateProcessTrees(panePids, () => destroyTmuxTarget(['kill-session', '-t', name]));
  } catch (error) {
    if (isMissingTmuxTarget(error)) return;
    throw error;
  }
}

export function parseTmuxSessions(output: string, processes = new Map<number, ProcessRecord>()): TmuxSession[] {
  return parseTmuxSessionsWithProcesses(output, processes);
}

export function parseTmuxSessionActivity(output: string): TmuxSessionActivity[] {
  const activityByName = new Map<
    string,
    {
      mainWindowIndex: number;
      mainLastOutputAt: number | null;
    }
  >();
  for (const line of output.trim().split('\n').filter(Boolean)) {
    const [name, windowIndexValue, lastOutputAtValue] = line.split('\t');
    if (!name) continue;
    const windowIndex = Number(lastOutputAtValue === undefined ? 0 : windowIndexValue);
    const timestamp = Number(lastOutputAtValue ?? windowIndexValue);
    const lastOutputAt = Number.isFinite(timestamp) ? timestamp * 1_000 : null;
    const previous = activityByName.get(name);
    activityByName.set(name, {
      mainWindowIndex: Math.min(previous?.mainWindowIndex ?? Number.MAX_SAFE_INTEGER, windowIndex),
      mainLastOutputAt:
        !previous || windowIndex < previous.mainWindowIndex
          ? lastOutputAt
          : windowIndex === previous.mainWindowIndex
            ? lastOutputAt
            : previous.mainLastOutputAt,
    });
  }
  return [...activityByName].map(([name, activity]) => ({
    name,
    lastOutputAt: activity.mainLastOutputAt,
    mainLastOutputAt: activity.mainLastOutputAt,
  }));
}

function parseTmuxSessionsWithProcesses(output: string, processes: Map<number, ProcessRecord>): TmuxSession[] {
  type WindowRow = {
    workspaceName: string;
    createdAt: number | null;
    attachedClients: number;
    terminal: TmuxTerminal;
  };
  const rows: WindowRow[] = output
    .trim()
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      const [
        workspaceName,
        createdAt,
        attachedClients,
        windowIndex,
        windowId,
        windowName,
        windowActive,
        lastOutputAt,
        _paneId,
        currentCommand,
        panePidValue,
        title,
        backgroundCommand,
        backgroundStartedAt,
        paneDead,
        paneDeadStatus,
      ] = line.split('\t');
      const terminalId = windowId ?? '';
      if (!workspaceName || !/^@\d+$/.test(terminalId)) return [];

      const created = Number(createdAt);
      const lastOutput = Number(lastOutputAt);
      const attached = Number(attachedClients);
      const index = Number(windowIndex);
      const panePid = Number(panePidValue);
      const startedAt = Number(backgroundStartedAt);
      const exitCode = Number(paneDeadStatus);
      const exited = paneDead === '1';
      return [
        {
          workspaceName,
          createdAt: Number.isFinite(created) ? created * 1_000 : null,
          attachedClients: Number.isFinite(attached) ? attached : 0,
          terminal: {
            id: terminalId,
            index: Number.isInteger(index) && index >= 0 ? index : 0,
            name: windowName || 'terminal',
            active: windowActive === '1',
            lastOutputAt: Number.isFinite(lastOutput) ? lastOutput * 1_000 : null,
            foregroundProcess: exited
              ? null
              : classifyProcess(currentCommand ?? '', title ?? '', Number.isFinite(panePid) ? panePid : 0, processes),
            command: backgroundCommand || null,
            startedAt: Number.isFinite(startedAt) && startedAt > 0 ? startedAt : null,
            state: exited ? 'exited' : 'running',
            exitCode: exited && Number.isInteger(exitCode) ? exitCode : null,
          },
        },
      ];
    });
  const rowsByWorkspace = new Map<string, WindowRow[]>();
  for (const row of rows) {
    const workspaceRows = rowsByWorkspace.get(row.workspaceName) ?? [];
    workspaceRows.push(row);
    rowsByWorkspace.set(row.workspaceName, workspaceRows);
  }

  return [...rowsByWorkspace].map(([name, workspaceRows]) => {
    const terminals = workspaceRows.map((row) => row.terminal).sort((left, right) => left.index - right.index);
    const mainTerminal = terminals[0];
    return {
      name,
      createdAt: workspaceRows[0]?.createdAt ?? null,
      lastOutputAt: mainTerminal?.lastOutputAt ?? null,
      attachedClients: Math.max(...workspaceRows.map((row) => row.attachedClients), 0),
      foregroundProcess: mainTerminal?.foregroundProcess ?? null,
      terminals,
    };
  });
}

export async function listTmuxSessions(): Promise<TmuxSession[]> {
  try {
    const [{ stdout }, processTable] = await Promise.all([
      execFile('tmux', ['list-windows', '-a', '-F', TMUX_WINDOW_FORMAT]),
      listProcesses().catch(() => new Map<number, ProcessRecord>()),
    ]);
    return parseTmuxSessionsWithProcesses(stdout, processTable);
  } catch (error) {
    if (isTmuxUnavailable(error)) return [];
    throw error;
  }
}

export async function listTmuxSessionActivity(): Promise<TmuxSessionActivity[]> {
  try {
    const { stdout } = await execFile('tmux', [
      'list-windows',
      '-a',
      '-F',
      '#{session_name}\t#{window_index}\t#{window_activity}',
    ]);
    return parseTmuxSessionActivity(stdout);
  } catch (error) {
    if (isTmuxUnavailable(error)) return [];
    throw error;
  }
}
