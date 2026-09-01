export type TerminalInputMode = 'compose' | 'terminal';

export const TERMINAL_INPUT_MODE_STORAGE_KEY = 'vampire:terminal-input-mode';
export const TERMINAL_SLASH_HANDOFF_STORAGE_KEY = 'vampire:terminal-slash-handoff';

function storedInputMode(): TerminalInputMode {
  if (typeof window === 'undefined') return 'terminal';
  try {
    return window.localStorage.getItem(TERMINAL_INPUT_MODE_STORAGE_KEY) === 'compose' ? 'compose' : 'terminal';
  } catch {
    return 'terminal';
  }
}

function storedSlashHandoff(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage.getItem(TERMINAL_SLASH_HANDOFF_STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
}

export class TerminalInputPreferences {
  mode = $state<TerminalInputMode>(storedInputMode());
  slashHandoff = $state(storedSlashHandoff());

  #started = false;

  start(): () => void {
    this.mode = storedInputMode();
    this.slashHandoff = storedSlashHandoff();
    if (this.#started) return () => undefined;
    this.#started = true;

    const syncAcrossTabs = (event: StorageEvent) => {
      if (event.key === TERMINAL_INPUT_MODE_STORAGE_KEY) this.mode = storedInputMode();
      if (event.key === TERMINAL_SLASH_HANDOFF_STORAGE_KEY) this.slashHandoff = storedSlashHandoff();
    };
    window.addEventListener('storage', syncAcrossTabs);
    return () => {
      window.removeEventListener('storage', syncAcrossTabs);
      this.#started = false;
    };
  }

  setMode(mode: TerminalInputMode) {
    this.mode = mode;
    try {
      window.localStorage.setItem(TERMINAL_INPUT_MODE_STORAGE_KEY, mode);
    } catch {
      // Keep the preference active for this page when storage is unavailable.
    }
  }

  setSlashHandoff(enabled: boolean) {
    this.slashHandoff = enabled;
    try {
      window.localStorage.setItem(TERMINAL_SLASH_HANDOFF_STORAGE_KEY, String(enabled));
    } catch {
      // Keep the preference active for this page when storage is unavailable.
    }
  }
}

export const terminalInputPreferences = new TerminalInputPreferences();
