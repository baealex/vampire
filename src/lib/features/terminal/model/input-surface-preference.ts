export type TerminalInputSurface = 'compose' | 'terminal';

const LAST_FOCUSED_INPUT_SURFACE_STORAGE_PREFIX = 'vampire:last-focused-input-surface:v2';

type InputSurfaceStorage = Pick<Storage, 'getItem' | 'setItem'>;

function inputSurfaceStorageKey(workspaceId: string, terminalId?: string): string {
  return `${LAST_FOCUSED_INPUT_SURFACE_STORAGE_PREFIX}:${encodeURIComponent(workspaceId)}:${encodeURIComponent(terminalId ?? 'main')}`;
}

export function loadLastFocusedInputSurface(
  workspaceId: string,
  terminalId?: string,
  storage?: InputSurfaceStorage
): {
  value: TerminalInputSurface | undefined;
  available: boolean;
} {
  try {
    const value = (storage ?? window.sessionStorage).getItem(inputSurfaceStorageKey(workspaceId, terminalId));
    return {
      value: value === 'compose' || value === 'terminal' ? value : undefined,
      available: true,
    };
  } catch {
    return { value: undefined, available: false };
  }
}

export function saveLastFocusedInputSurface(
  workspaceId: string,
  terminalId: string | undefined,
  value: TerminalInputSurface,
  storage?: InputSurfaceStorage
): boolean {
  try {
    (storage ?? window.sessionStorage).setItem(inputSurfaceStorageKey(workspaceId, terminalId), value);
    return true;
  } catch {
    return false;
  }
}
