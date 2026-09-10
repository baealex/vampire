import { create } from 'zustand';

export type AppTheme = 'dark' | 'light';
export type AppThemePreference = AppTheme | 'system';

export const THEME_STORAGE_KEY = 'vampire:theme';
export const THEME_CHANGE_EVENT = 'vampire:theme-change';

type ThemeStore = {
  current: AppTheme;
  preference: AppThemePreference;
  setPreference: (preference: AppThemePreference) => void;
  toggle: () => void;
};

type ViewTransitionDocument = Document & { startViewTransition?: (update: () => void) => unknown };

function isAppTheme(value: unknown): value is AppTheme {
  return value === 'dark' || value === 'light';
}

function preferredTheme(): AppTheme {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function savedPreference(): AppThemePreference {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return isAppTheme(value) ? value : 'system';
  } catch {
    return 'system';
  }
}

function applyTheme(theme: AppTheme): void {
  document.documentElement.dataset.theme = theme;
  const themeColor = getComputedStyle(document.documentElement).getPropertyValue('--color-browser-chrome').trim();
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute('content', themeColor);
  window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: theme }));
}

function persistPreference(preference: AppThemePreference): void {
  try {
    if (preference === 'system') localStorage.removeItem(THEME_STORAGE_KEY);
    else localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // The active theme still works when storage is unavailable.
  }
}

const initialPreference = typeof window === 'undefined' ? 'system' : savedPreference();
const initialTheme: AppTheme =
  typeof document === 'undefined'
    ? 'dark'
    : isAppTheme(document.documentElement.dataset.theme)
      ? document.documentElement.dataset.theme
      : initialPreference === 'system'
        ? preferredTheme()
        : initialPreference;

export const useTheme = create<ThemeStore>((set, get) => ({
  current: initialTheme,
  preference: initialPreference,
  setPreference(preference) {
    persistPreference(preference);
    const nextTheme = preference === 'system' ? preferredTheme() : preference;
    const update = () => {
      applyTheme(nextTheme);
      set({ current: nextTheme, preference });
    };
    const transitionDocument = document as ViewTransitionDocument;
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches && transitionDocument.startViewTransition) {
      transitionDocument.startViewTransition(update);
    } else {
      update();
    }
  },
  toggle() {
    get().setPreference(get().current === 'dark' ? 'light' : 'dark');
  },
}));

export function initializeTheme(): () => void {
  applyTheme(useTheme.getState().current);
  const mediaQuery = matchMedia('(prefers-color-scheme: light)');
  const followSystem = (event: MediaQueryListEvent) => {
    if (useTheme.getState().preference !== 'system') return;
    const current = event.matches ? 'light' : 'dark';
    applyTheme(current);
    useTheme.setState({ current });
  };
  mediaQuery.addEventListener('change', followSystem);
  return () => mediaQuery.removeEventListener('change', followSystem);
}

function cssToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function terminalFontFamily(): string {
  return cssToken('--font-mono');
}

export function terminalTheme() {
  return {
    background: cssToken('--color-terminal-background'),
    foreground: cssToken('--color-terminal-foreground'),
    cursor: cssToken('--color-terminal-cursor'),
    selectionBackground: cssToken('--color-terminal-selection'),
    black: cssToken('--terminal-black'),
    red: cssToken('--terminal-red'),
    green: cssToken('--terminal-green'),
    yellow: cssToken('--terminal-yellow'),
    blue: cssToken('--terminal-blue'),
    magenta: cssToken('--terminal-magenta'),
    cyan: cssToken('--terminal-cyan'),
    white: cssToken('--terminal-white'),
    brightBlack: cssToken('--terminal-bright-black'),
    brightRed: cssToken('--terminal-bright-red'),
    brightGreen: cssToken('--terminal-bright-green'),
    brightYellow: cssToken('--terminal-bright-yellow'),
    brightBlue: cssToken('--terminal-bright-blue'),
    brightMagenta: cssToken('--terminal-bright-magenta'),
    brightCyan: cssToken('--terminal-bright-cyan'),
    brightWhite: cssToken('--terminal-bright-white'),
  };
}
