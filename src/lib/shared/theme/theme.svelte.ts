export type AppTheme = 'dark' | 'light';
export type AppThemePreference = AppTheme | 'system';

export const THEME_STORAGE_KEY = 'vampire:theme';
export const THEME_CHANGE_EVENT = 'vampire:theme-change';

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => unknown;
};

function isAppTheme(value: unknown): value is AppTheme {
  return value === 'dark' || value === 'light';
}

function initialTheme(): AppTheme {
  if (typeof document === 'undefined') return 'dark';
  const documentTheme = document.documentElement.dataset.theme;
  return isAppTheme(documentTheme) ? documentTheme : 'dark';
}

function storedTheme(): AppTheme | undefined {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isAppTheme(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function storeTheme(theme: AppThemePreference) {
  try {
    if (theme === 'system') window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // The active theme still works when storage is unavailable.
  }
}

function preferredTheme(): AppTheme {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
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

export class ThemeState {
  current = $state<AppTheme>(initialTheme());
  preference = $state<AppThemePreference>('system');

  #followsSystem = false;

  start(): () => void {
    const savedTheme = storedTheme();
    this.#followsSystem = savedTheme === undefined;
    this.preference = savedTheme ?? 'system';
    const documentTheme = document.documentElement.dataset.theme;
    this.current = isAppTheme(documentTheme) ? documentTheme : (savedTheme ?? preferredTheme());
    this.#applyTheme();

    const mediaQuery = window.matchMedia('(prefers-color-scheme: light)');
    const followSystemTheme = (event: MediaQueryListEvent) => {
      if (!this.#followsSystem) return;
      this.current = event.matches ? 'light' : 'dark';
      this.#applyTheme();
    };
    mediaQuery.addEventListener('change', followSystemTheme);

    return () => mediaQuery.removeEventListener('change', followSystemTheme);
  }

  toggle() {
    const nextTheme: AppTheme = this.current === 'dark' ? 'light' : 'dark';
    this.setPreference(nextTheme);
  }

  setPreference(preference: AppThemePreference) {
    this.preference = preference;
    this.#followsSystem = preference === 'system';
    storeTheme(preference);
    const nextTheme = preference === 'system' ? preferredTheme() : preference;
    const update = () => {
      this.current = nextTheme;
      this.#applyTheme();
    };
    const transitionDocument = document as ViewTransitionDocument;
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches && transitionDocument.startViewTransition) {
      transitionDocument.startViewTransition(update);
    } else {
      update();
    }
  }

  #applyTheme() {
    document.documentElement.dataset.theme = this.current;
    const themeColor = cssToken('--color-browser-chrome');
    document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute('content', themeColor);
    window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: this.current }));
  }
}

export const themeState = new ThemeState();
