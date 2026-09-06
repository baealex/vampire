export const TERMINAL_FONT_SIZE_KEY = 'vampire:terminal-font-size';
export const MINIMUM_TERMINAL_FONT_SIZE = 10;
export const MAXIMUM_TERMINAL_FONT_SIZE = 22;

export function loadTerminalFontSize(fallback: number): number {
  try {
    const size = Number(window.localStorage.getItem(TERMINAL_FONT_SIZE_KEY));
    return Number.isInteger(size) && size >= MINIMUM_TERMINAL_FONT_SIZE && size <= MAXIMUM_TERMINAL_FONT_SIZE
      ? size
      : fallback;
  } catch {
    return fallback;
  }
}

export function saveTerminalFontSize(size: number): boolean {
  if (!Number.isInteger(size) || size < MINIMUM_TERMINAL_FONT_SIZE || size > MAXIMUM_TERMINAL_FONT_SIZE) return false;
  try {
    window.localStorage.setItem(TERMINAL_FONT_SIZE_KEY, String(size));
    return true;
  } catch {
    return false;
  }
}
