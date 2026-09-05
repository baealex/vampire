export type TerminalInputSurface = 'compose' | 'terminal';

const LAST_FOCUSED_INPUT_SURFACE_STORAGE_KEY = 'vampire:last-focused-input-surface:v1';

type InputSurfaceStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function loadLastFocusedInputSurface(storage: InputSurfaceStorage = window.sessionStorage): {
  value: TerminalInputSurface | undefined;
  available: boolean;
} {
  try {
    const value = storage.getItem(LAST_FOCUSED_INPUT_SURFACE_STORAGE_KEY);
    return {
      value: value === 'compose' || value === 'terminal' ? value : undefined,
      available: true,
    };
  } catch {
    return { value: undefined, available: false };
  }
}

export function saveLastFocusedInputSurface(
  value: TerminalInputSurface,
  storage: InputSurfaceStorage = window.sessionStorage
): boolean {
  try {
    storage.setItem(LAST_FOCUSED_INPUT_SURFACE_STORAGE_KEY, value);
    return true;
  } catch {
    return false;
  }
}
