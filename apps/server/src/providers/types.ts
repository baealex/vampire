import type { ChildProcess } from 'node:child_process';

export interface ProviderInfo {
  name: string;
  displayName: string;
  coAuthor: string;
}

export interface StreamCallbacks {
  onToolUse: (name: string, input: Record<string, any>) => void;
  onText: (text: string) => void;
}

export interface RunAgentHandle {
  child: ChildProcess;
  result: Promise<string>;
}

export interface Provider {
  info: ProviderInfo;
  testConnection(): Promise<{ ok: boolean; message: string }>;
  runAgent(params: { prompt: string; cwd: string; callbacks: StreamCallbacks }): RunAgentHandle;
}
