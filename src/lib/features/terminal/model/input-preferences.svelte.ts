import { requestJson } from '~/lib/shared/api/request.ts';
import {
  DEFAULT_TERMINAL_INPUT_SETTINGS,
  type TerminalInputMode,
  type TerminalInputSettings,
} from '~/lib/shared/contracts/terminal-input.ts';

export type { TerminalInputMode, TerminalInputSettings } from '~/lib/shared/contracts/terminal-input.ts';

export class TerminalInputPreferences {
  mode = $state<TerminalInputMode>(DEFAULT_TERMINAL_INPUT_SETTINGS.mode);
  slashHandoff = $state(DEFAULT_TERMINAL_INPUT_SETTINGS.slashHandoff);
  loadError = $state('');
  loaded = $state(false);

  #loadPromise: Promise<void> | undefined;
  #mutationVersion = 0;

  get settings(): TerminalInputSettings {
    return {
      mode: this.mode,
      slashHandoff: this.slashHandoff,
    };
  }

  start(): () => void {
    void this.refresh();
    return () => undefined;
  }

  async refresh(): Promise<void> {
    if (this.#loadPromise) return this.#loadPromise;
    const mutationVersion = this.#mutationVersion;
    this.#loadPromise = requestJson<TerminalInputSettings>(
      '/api/terminal-input/settings',
      undefined,
      'Unable to load terminal input settings'
    )
      .then((settings) => {
        if (mutationVersion === this.#mutationVersion) this.apply(settings);
      })
      .catch((error) => {
        this.loadError = error instanceof Error ? error.message : 'Unable to load terminal input settings';
      })
      .finally(() => {
        this.#loadPromise = undefined;
      });
    return this.#loadPromise;
  }

  async update(settings: TerminalInputSettings): Promise<void> {
    const mutationVersion = ++this.#mutationVersion;
    const saved = await requestJson<TerminalInputSettings>(
      '/api/terminal-input/settings',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(settings),
      },
      'Unable to save terminal input settings'
    );
    if (mutationVersion === this.#mutationVersion) this.apply(saved);
  }

  apply(settings: TerminalInputSettings) {
    this.mode = settings.mode;
    this.slashHandoff = settings.slashHandoff;
    this.loadError = '';
    this.loaded = true;
  }
}

export const terminalInputPreferences = new TerminalInputPreferences();
