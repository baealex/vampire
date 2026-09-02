export type TerminalInputMode = 'compose' | 'terminal';

export type TerminalInputSettings = {
  mode: TerminalInputMode;
  slashHandoff: boolean;
};

export const DEFAULT_TERMINAL_INPUT_SETTINGS: TerminalInputSettings = {
  mode: 'terminal',
  slashHandoff: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isTerminalInputSettings(value: unknown): value is TerminalInputSettings {
  return (
    isRecord(value) &&
    (value.mode === 'compose' || value.mode === 'terminal') &&
    typeof value.slashHandoff === 'boolean'
  );
}
