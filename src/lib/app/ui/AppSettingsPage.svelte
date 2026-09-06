<script lang="ts">
import LogOut from '@lucide/svelte/icons/log-out';
import Clock3 from '@lucide/svelte/icons/clock-3';
import Plus from '@lucide/svelte/icons/plus';
import Save from '@lucide/svelte/icons/save';
import Settings2 from '@lucide/svelte/icons/settings-2';
import Trash2 from '@lucide/svelte/icons/trash-2';
import { onMount, untrack } from 'svelte';
import {
  loadTerminalFontSize,
  saveTerminalFontSize,
  MINIMUM_TERMINAL_FONT_SIZE,
  MAXIMUM_TERMINAL_FONT_SIZE,
} from '~/lib/features/terminal/model/terminal-display-preference.ts';
import { COMPACT_MEDIA_QUERY } from '~/lib/shared/ui/layout.ts';
import { MAX_LAUNCH_PROFILES } from '~/lib/shared/contracts/launch-profiles.ts';
import {
  MAX_WORKSPACE_COMPOSER_PROMPTS,
  MIN_WORKSPACE_COMPOSER_PROMPTS,
  type WorkspaceComposerHistorySettings,
} from '~/lib/shared/contracts/workspace-composer-history.ts';
import type { LaunchProfile, ManagedWorkspace } from '~/lib/shared/contracts/workspace.ts';
import { themeState, type AppThemePreference } from '~/lib/shared/theme/theme.svelte.ts';
import Button from '~/lib/shared/ui/Button.svelte';
import Input from '~/lib/shared/ui/Input.svelte';
import ManagementSurface from '~/lib/shared/ui/ManagementSurface.svelte';
import Select from '~/lib/shared/ui/Select.svelte';

let {
  launchProfiles,
  defaultStartupProfileId,
  workspaceShortcutModifier = '⌘',
  composerHistorySettings,
  workspaces,
  close,
  onSaveLaunchProfiles,
  onSaveComposerHistorySettings,
  onManageAutomations,
  onManageWidgets,
  onLogout,
  onBusyChange = () => undefined,
  onDirtyChange = () => undefined,
}: {
  launchProfiles: LaunchProfile[];
  defaultStartupProfileId: string | null;
  workspaceShortcutModifier?: string;
  composerHistorySettings: WorkspaceComposerHistorySettings;
  workspaces: ManagedWorkspace[];
  close: () => void;
  onSaveLaunchProfiles: (
    profiles: LaunchProfile[],
    defaultProfileId: string | null,
    applyDefaultToAll: boolean
  ) => Promise<{ ok: boolean; error?: string }>;
  onSaveComposerHistorySettings: (
    settings: WorkspaceComposerHistorySettings
  ) => Promise<{ ok: boolean; error?: string }>;
  onManageAutomations: () => void;
  onManageWidgets: () => void;
  onLogout?: () => void;
  onBusyChange?: (busy: boolean) => void;
  onDirtyChange?: (dirty: boolean) => void;
} = $props();

let terminalFontSize = $state(14);
let terminalFontSaveFailed = $state(false);
onMount(() => {
  terminalFontSize = loadTerminalFontSize(window.matchMedia(COMPACT_MEDIA_QUERY).matches ? 12 : 14);
});
function changeTerminalFontSize(event: Event) {
  const size = Number((event.currentTarget as HTMLSelectElement).value);
  terminalFontSaveFailed = !saveTerminalFontSize(size);
  if (!terminalFontSaveFailed) terminalFontSize = size;
}

const keyboardShortcuts = $derived([
  {
    title: 'Switch input',
    keys: [workspaceShortcutModifier === '⌘' ? '⌘ /' : 'Ctrl + `'],
    description: 'Switch between Compose and Terminal, keeping your draft and cursor position.',
  },
  {
    title: 'Switch workspace',
    keys: [`${workspaceShortcutModifier}1–0`],
    description: 'Open a running workspace by its position in the list.',
  },
  {
    title: 'Compose → Terminal',
    keys: ['/'],
    description: 'In an empty Compose field, type / to focus the terminal and send the slash.',
  },
  {
    title: 'Scroll terminal history',
    keys: ['Shift+PageUp', 'Shift+PageDown'],
    description: 'Scroll one page with the terminal focused or Compose empty.',
  },
  {
    title: 'Jump to top or bottom',
    keys: ['Shift+Home', 'Shift+End'],
    description: 'Jump through terminal history with the terminal focused or Compose empty.',
  },
  {
    title: 'Search Composer history',
    keys: ['Ctrl+Alt+H'],
    description: 'Search previous messages and insert one with Enter.',
  },
  {
    title: 'Recover a message',
    keys: ['Ctrl+Alt+R'],
    description: 'Insert the latest unconfirmed or failed message without sending it.',
  },
  {
    title: 'Insert a literal slash',
    keys: ['Ctrl+/'],
    description: 'Start a Compose draft with / without switching to Terminal.',
  },
]);

let editableProfiles = $state<LaunchProfile[]>(untrack(() => launchProfiles.map((profile) => ({ ...profile }))));
let selectedDefaultProfileId = $state(untrack(() => defaultStartupProfileId ?? ''));
let syncedProfiles = $state(JSON.stringify(untrack(() => launchProfiles)));
let syncedDefaultProfileId = $state(untrack(() => defaultStartupProfileId ?? ''));
let saving = $state(false);
let savingError = $state('');
let savedMessage = $state('');
let historyEnabled = $state(untrack(() => composerHistorySettings.enabled));
let historyLimit = $state(String(untrack(() => composerHistorySettings.limit)));
let syncedHistorySettings = $state(JSON.stringify(untrack(() => composerHistorySettings)));
let historySavingError = $state('');
let historySavedMessage = $state('');
const profileChanges = $derived(
  JSON.stringify(editableProfiles) !== syncedProfiles || selectedDefaultProfileId !== syncedDefaultProfileId
);
const historyChanges = $derived(
  JSON.stringify({ enabled: historyEnabled, limit: Number(historyLimit) }) !== syncedHistorySettings
);

$effect(() => {
  const incomingProfiles = JSON.stringify(launchProfiles);
  const incomingDefault = defaultStartupProfileId ?? '';
  if (incomingProfiles === syncedProfiles && incomingDefault === syncedDefaultProfileId) return;
  if (untrack(() => profileChanges)) return;
  editableProfiles = launchProfiles.map((profile) => ({ ...profile }));
  selectedDefaultProfileId = incomingDefault;
  syncedProfiles = incomingProfiles;
  syncedDefaultProfileId = incomingDefault;
});

$effect(() => {
  onDirtyChange(profileChanges || historyChanges);
});

$effect(() => {
  const incoming = JSON.stringify(composerHistorySettings);
  if (incoming === syncedHistorySettings || untrack(() => historyChanges)) return;
  historyEnabled = composerHistorySettings.enabled;
  historyLimit = String(composerHistorySettings.limit);
  syncedHistorySettings = incoming;
});

function setTheme(preference: AppThemePreference) {
  themeState.setPreference(preference);
}

function addProfile() {
  if (editableProfiles.length >= MAX_LAUNCH_PROFILES) return;
  const id = globalThis.crypto?.randomUUID?.() ?? 'profile-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  editableProfiles = [
    ...editableProfiles,
    {
      id,
      name: 'Profile ' + (editableProfiles.length + 1),
      command: '',
    },
  ];
  if (!selectedDefaultProfileId) selectedDefaultProfileId = id;
  savingError = '';
  savedMessage = '';
}

function removeProfile(profileId: string) {
  editableProfiles = editableProfiles.filter((profile) => profile.id !== profileId);
  if (selectedDefaultProfileId === profileId) selectedDefaultProfileId = '';
  savingError = '';
  savedMessage = '';
}

function validateProfiles(): string | undefined {
  const names = new Set<string>();
  for (const profile of editableProfiles) {
    profile.name = profile.name.trim();
    profile.command = profile.command.trim();
    if (!profile.name) return 'Give every launch profile a name.';
    if (!profile.command) return 'Give every launch profile a command.';
    const normalizedName = profile.name.toLocaleLowerCase();
    if (names.has(normalizedName)) return 'Launch profile names must be unique.';
    names.add(normalizedName);
    if (/[\0\r\n\t]/.test(profile.name) || /[\0\r\n\t]/.test(profile.command)) {
      return 'Names and commands must stay on one line.';
    }
  }
  if (selectedDefaultProfileId && !editableProfiles.some((profile) => profile.id === selectedDefaultProfileId)) {
    selectedDefaultProfileId = '';
  }
  return undefined;
}

async function saveLaunchProfiles() {
  savingError = validateProfiles() ?? '';
  savedMessage = '';
  if (savingError) return;
  const defaultProfileId = selectedDefaultProfileId || null;
  const applyDefaultToAll = selectedDefaultProfileId !== syncedDefaultProfileId;
  saving = true;
  onBusyChange(true);
  try {
    const result = await onSaveLaunchProfiles(
      editableProfiles.map((profile) => ({ ...profile })),
      defaultProfileId,
      applyDefaultToAll
    );
    if (!result.ok) {
      savingError = result.error ?? 'Unable to save launch profiles.';
      return;
    }
    syncedProfiles = JSON.stringify(editableProfiles);
    syncedDefaultProfileId = selectedDefaultProfileId;
    savedMessage = applyDefaultToAll
      ? 'Default updated for ' + workspaces.length + ' ' + (workspaces.length === 1 ? 'workspace.' : 'workspaces.')
      : 'Launch profiles saved.';
  } finally {
    saving = false;
    onBusyChange(false);
  }
}

async function saveComposerHistorySettings() {
  const limit = Number(historyLimit);
  historySavingError = '';
  historySavedMessage = '';
  if (!Number.isInteger(limit) || limit < MIN_WORKSPACE_COMPOSER_PROMPTS || limit > MAX_WORKSPACE_COMPOSER_PROMPTS) {
    historySavingError = `Keep between ${MIN_WORKSPACE_COMPOSER_PROMPTS} and ${MAX_WORKSPACE_COMPOSER_PROMPTS} prompts per workspace.`;
    return;
  }
  saving = true;
  onBusyChange(true);
  try {
    const settings = { enabled: historyEnabled, limit };
    const result = await onSaveComposerHistorySettings(settings);
    if (!result.ok) {
      historySavingError = result.error ?? 'Unable to save Composer history settings.';
      return;
    }
    syncedHistorySettings = JSON.stringify(settings);
    historySavedMessage = historyEnabled
      ? `Composer history will keep ${limit} ${limit === 1 ? 'prompt' : 'prompts'} per workspace.`
      : 'Composer history is off. Existing history is retained.';
  } finally {
    saving = false;
    onBusyChange(false);
  }
}
</script>

<ManagementSurface
  title="Settings"
  titleId="application-settings-title"
  eyebrow="Vampire"
  {close}
  closeLabel="Close settings"
  busy={saving}
  showFooter={false}
>
  {#snippet children()}
    <div class="settings-page">
      <section class="settings-section" aria-labelledby="appearance-settings-title">
        <div class="settings-section-heading">
          <div>
            <div class="settings-title-row">
              <h2 id="appearance-settings-title">Appearance</h2>
              <span>Browser</span>
            </div>
            <p>Saved in this browser.</p>
          </div>
        </div>
        <div class="choice-grid choice-grid--three" role="radiogroup" aria-label="Theme">
          {#each [
            { value: 'system' as const, label: 'System', detail: 'Follow this device' },
            { value: 'dark' as const, label: 'Dark', detail: 'Always dark' },
            { value: 'light' as const, label: 'Light', detail: 'Always light' },
          ] as option}
            <label class:active={themeState.preference === option.value} class="choice-card">
              <input
                type="radio"
                name="theme-preference"
                value={option.value}
                checked={themeState.preference === option.value}
                onchange={() => setTheme(option.value)}
              >
              <span>
                <strong>{option.label}</strong>
                <small>{option.detail}</small>
              </span>
            </label>
          {/each}
        </div>
        <label class="history-limit-field">
          <span>
            <strong>Terminal text size</strong>
            <small>Applies when you open or return to a terminal in this browser.</small>
          </span>
          <Select ariaLabel="Terminal text size" value={String(terminalFontSize)} onchange={changeTerminalFontSize}>
            {#each Array.from({ length: MAXIMUM_TERMINAL_FONT_SIZE - MINIMUM_TERMINAL_FONT_SIZE + 1 }, (_, index) => MINIMUM_TERMINAL_FONT_SIZE + index) as size (size)}
              <option value={size}>{size}px</option>
            {/each}
          </Select>
        </label>
        {#if terminalFontSaveFailed}
          <p role="alert">The text size could not be saved in this browser.</p>
        {/if}
      </section>

      <section class="settings-section" aria-labelledby="composer-history-settings-title">
        <div class="settings-section-heading">
          <div>
            <div class="settings-title-row">
              <h2 id="composer-history-settings-title">Composer history</h2>
              <span>Server</span>
            </div>
            <p>Only prompts successfully sent from Compose are saved. Direct terminal input is never recorded.</p>
          </div>
        </div>
        <label class="toggle-row">
          <input type="checkbox" bind:checked={historyEnabled} disabled={saving}>
          <span>
            <strong>Save Compose history</strong>
            <small>Show the latest prompt as workspace context and make recent prompts available for reuse.</small>
          </span>
        </label>
        <label class="history-limit-field">
          <span>
            <strong>Prompts per workspace</strong>
            <small>Lowering this limit permanently removes the oldest saved prompts.</small>
          </span>
          <Input
            type="number"
            bind:value={historyLimit}
            min={MIN_WORKSPACE_COMPOSER_PROMPTS}
            max={MAX_WORKSPACE_COMPOSER_PROMPTS}
            step={1}
            disabled={saving || !historyEnabled}
            ariaLabel="Prompts saved per workspace"
          />
        </label>
        <div class="profile-actions">
          <div aria-live="polite">
            {#if historySavingError}
              <p class="feedback feedback--error" role="alert">{historySavingError}</p>
            {:else if historySavedMessage}
              <p class="feedback">{historySavedMessage}</p>
            {/if}
          </div>
          <Button
            variant="primary"
            size="sm"
            onclick={() => void saveComposerHistorySettings()}
            disabled={saving || !historyChanges}
          >
            <Save size={15} strokeWidth={1.9} aria-hidden="true" />
            <span>{saving ? 'Saving…' : 'Save history settings'}</span>
          </Button>
        </div>
      </section>

      <section class="settings-section" aria-labelledby="launch-profile-settings-title">
        <div class="settings-section-heading settings-section-heading--action">
          <div>
            <div class="settings-title-row">
              <h2 id="launch-profile-settings-title">Launch profiles</h2>
              <span>Server</span>
            </div>
            <p>Profiles are shared by every workspace on this server.</p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onclick={addProfile}
            disabled={saving || editableProfiles.length >= MAX_LAUNCH_PROFILES}
          >
            <Plus size={15} strokeWidth={2} aria-hidden="true" />
            <span>Add profile</span>
          </Button>
        </div>

        <label class="default-profile-field">
          <span>
            <strong>Default for all workspaces</strong>
            <small>
              Changing this updates every registered workspace and becomes the default for new ones. Running shells are
              unchanged until reopened.
            </small>
          </span>
          <Select bind:value={selectedDefaultProfileId} disabled={saving}>
            <option value="">No startup profile</option>
            {#each editableProfiles as profile (profile.id)}
              <option value={profile.id}>{profile.name || 'Unnamed profile'}</option>
            {/each}
          </Select>
        </label>

        {#if editableProfiles.length > 0}
          <div class="profile-list">
            {#each editableProfiles as profile, index (profile.id)}
              <article class:default={selectedDefaultProfileId === profile.id} class="profile-card">
                <div class="profile-card-heading">
                  <label>
                    <span>Name</span>
                    <Input bind:value={profile.name} size="sm" maxlength={80} disabled={saving} />
                  </label>
                  <Button
                    variant="danger-outline"
                    class="remove-profile"
                    size="sm"
                    onclick={() => removeProfile(profile.id)}
                    disabled={saving}
                    ariaLabel={'Remove ' + (profile.name || 'profile ' + (index + 1))}
                  >
                    <Trash2 size={15} strokeWidth={1.8} aria-hidden="true" />
                  </Button>
                </div>
                <label>
                  <span>Command</span>
                  <Input
                    bind:value={profile.command}
                    size="sm"
                    mono
                    maxlength={1000}
                    spellcheck={false}
                    disabled={saving}
                  />
                </label>
                <small class="profile-state">
                  {selectedDefaultProfileId === profile.id ? 'Default for every workspace' : 'Available to every workspace'}
                </small>
              </article>
            {/each}
          </div>
        {:else}
          <div class="empty-profiles">
            <strong>No launch profiles</strong>
            <p>Add commands such as <code>codex</code>, <code>claude</code>, or your own agent launcher.</p>
          </div>
        {/if}

        <div class="profile-actions">
          <div aria-live="polite">
            {#if savingError}
              <p class="feedback feedback--error" role="alert">{savingError}</p>
            {:else if savedMessage}
              <p class="feedback">{savedMessage}</p>
            {/if}
          </div>
          <Button
            variant="primary"
            size="sm"
            onclick={() => void saveLaunchProfiles()}
            disabled={saving || !profileChanges}
          >
            <Save size={15} strokeWidth={1.9} aria-hidden="true" />
            <span>{saving ? 'Saving…' : 'Save profiles'}</span>
          </Button>
        </div>
      </section>

      <section class="settings-section" aria-labelledby="server-tools-settings-title">
        <div class="settings-section-heading">
          <div>
            <div class="settings-title-row">
              <h2 id="server-tools-settings-title">Server tools</h2>
              <span>Server</span>
            </div>
            <p>Manage server-wide utilities from one place.</p>
          </div>
        </div>
        <div class="settings-rows">
          <div class="settings-row">
            <span>
              <strong>Automations</strong>
              <small>Review and control scheduled prompts across every workspace.</small>
            </span>
            <Button variant="secondary" size="sm" ariaLabel="Manage all automations" onclick={onManageAutomations}>
              <Clock3 size={15} strokeWidth={1.8} aria-hidden="true" />
              <span>Manage</span>
            </Button>
          </div>
          <div class="settings-row">
            <span>
              <strong>Status widgets</strong>
              <small>Configure the information shown above every workspace terminal.</small>
            </span>
            <Button variant="secondary" size="sm" ariaLabel="Manage status widgets" onclick={onManageWidgets}>
              <Settings2 size={15} strokeWidth={1.8} aria-hidden="true" />
              <span>Manage</span>
            </Button>
          </div>
        </div>
      </section>

      {#if onLogout}
        <section class="settings-section" aria-labelledby="session-settings-title">
          <div class="settings-section-heading">
            <div>
              <div class="settings-title-row">
                <h2 id="session-settings-title">Session</h2>
                <span>Browser</span>
              </div>
              <p>End authentication for this browser.</p>
            </div>
          </div>
          <Button variant="danger-outline" onclick={onLogout}>
            <LogOut size={16} strokeWidth={1.8} aria-hidden="true" />
            <span>Sign out</span>
          </Button>
        </section>
      {/if}

      <section class="settings-section" aria-labelledby="terminal-input-settings-title">
        <div class="settings-section-heading">
          <div>
            <div class="settings-title-row">
              <h2 id="terminal-input-settings-title">Keyboard shortcuts</h2>
              <span>Desktop</span>
            </div>
            <p>Each workspace remembers its input surface, draft, and editing position.</p>
          </div>
        </div>
        <div class="shortcut-list" aria-label="Keyboard shortcuts">
          {#each keyboardShortcuts as shortcut (shortcut.title)}
            <div class="shortcut-row">
              <span class="shortcut-description">
                <strong>{shortcut.title}</strong>
                <small>{shortcut.description}</small>
              </span>
              <span class="shortcut-keys">
                {#each shortcut.keys as key (key)}
                  <kbd>{key}</kbd>
                {/each}
              </span>
            </div>
          {/each}
        </div>
      </section>
    </div>
  {/snippet}
</ManagementSurface>

<style>
.settings-page {
  display: grid;
  width: 100%;
  gap: 0;
}
.settings-section {
  display: grid;
  gap: 0.9rem;
  min-width: 0;
  padding: 0.25rem 0 1.5rem;
  border-bottom: 1px solid var(--color-border);
  background: transparent;
}
.settings-section + .settings-section {
  padding-top: 1.5rem;
}
.settings-section:last-child {
  border-bottom: 0;
}
.settings-section-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
}
.settings-section-heading--action {
  align-items: center;
}
.settings-title-row {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
}
.settings-title-row > span {
  color: var(--color-text-disabled);
  font-size: var(--text-nano);
  font-weight: var(--weight-medium);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.settings-section-heading h2,
.settings-section-heading p,
.empty-profiles p,
.feedback {
  margin: 0;
}
.settings-section-heading h2 {
  color: var(--color-text);
  font-size: var(--text-body);
  font-weight: var(--weight-strong);
}
.settings-section-heading p {
  margin-top: 0.2rem;
  color: var(--color-text-tertiary);
  font-size: var(--text-caption);
  line-height: var(--leading-body);
}
.choice-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.55rem;
}
.choice-grid--three {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}
.choice-card {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: start;
  gap: 0.6rem;
  min-width: 0;
  padding: 0.68rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-control-background);
  cursor: pointer;
}
.choice-card.active {
  border-color: var(--color-visual-accent-border);
  background: var(--color-surface-selected);
}
.choice-card:has(input:focus-visible) {
  border-color: var(--color-visual-accent-border-strong);
  box-shadow: var(--shadow-accent-focus);
}
.choice-card input,
.toggle-row input {
  margin: 0.18rem 0 0;
  accent-color: var(--color-accent);
}
.choice-card span,
.toggle-row span,
.default-profile-field > span,
.settings-row > span {
  display: grid;
  min-width: 0;
  gap: 0.2rem;
}
.choice-card strong,
.toggle-row strong,
.default-profile-field strong,
.settings-row strong,
.empty-profiles strong {
  color: var(--color-text);
  font-size: var(--text-label);
  font-weight: var(--weight-medium);
}
.choice-card small,
.toggle-row small,
.default-profile-field small,
.settings-row small,
.profile-state {
  color: var(--color-text-tertiary);
  font-size: var(--text-nano);
  line-height: var(--leading-body);
}
.toggle-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: start;
  gap: 0.65rem;
  padding: 0.2rem 0.1rem;
  cursor: pointer;
}
.shortcut-list {
  display: grid;
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-control-background);
}
.shortcut-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.75rem;
  min-width: 0;
  padding: 0.65rem 0.75rem;
}
.shortcut-row + .shortcut-row {
  border-top: 1px solid var(--color-border);
}
.shortcut-keys {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.35rem;
}
.shortcut-description {
  display: grid;
  flex: 1 1 auto;
  gap: 0.2rem;
  min-width: 0;
}
.shortcut-description strong {
  color: var(--color-text);
  font-size: var(--text-label);
  font-weight: var(--weight-medium);
}
.shortcut-description small {
  color: var(--color-text-tertiary);
  font-size: var(--text-caption);
  line-height: var(--leading-body);
}
kbd,
code {
  font-family: var(--font-mono);
}
kbd {
  padding: 0.05rem 0.28rem;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-xs);
  background: var(--color-control-background);
  font-size: var(--text-caption);
  line-height: var(--leading-ui);
  white-space: nowrap;
}
@media (max-width: 40rem) {
  .shortcut-row {
    grid-template-columns: minmax(0, 1fr);
    gap: 0.45rem;
  }
}
.default-profile-field {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(12rem, 18rem);
  align-items: center;
  gap: 1rem;
  padding: 0.75rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-control-background);
}
.history-limit-field {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 7rem;
  align-items: center;
  gap: 1rem;
  padding: 0.75rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-control-background);
}
.history-limit-field > span {
  display: grid;
  min-width: 0;
  gap: 0.2rem;
}
.history-limit-field strong {
  color: var(--color-text);
  font-size: var(--text-label);
  font-weight: var(--weight-medium);
}
.history-limit-field small {
  color: var(--color-text-tertiary);
  font-size: var(--text-nano);
  line-height: var(--leading-body);
}
.profile-list {
  display: grid;
  gap: 0.6rem;
}
.profile-card {
  display: grid;
  gap: 0.6rem;
  padding: 0.75rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-control-background);
}
.profile-card.default {
  border-color: var(--color-visual-accent-border);
  background: var(--color-surface-selected);
}
.profile-card-heading {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: end;
  gap: 0.55rem;
}
.profile-card label {
  display: grid;
  gap: 0.3rem;
  min-width: 0;
  color: var(--color-text-secondary);
  font-size: var(--text-nano);
  font-weight: var(--weight-medium);
}
:global(.remove-profile) {
  width: var(--control-height-sm);
  min-width: var(--control-height-sm);
  padding: 0;
}
.profile-state {
  justify-self: start;
}
.empty-profiles {
  padding: 1.2rem;
  border: 1px dashed var(--color-border-strong);
  border-radius: var(--radius-md);
  color: var(--color-text-tertiary);
  text-align: center;
}
.empty-profiles p {
  margin-top: 0.3rem;
  font-size: var(--text-caption);
}
.profile-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  min-height: var(--control-height-md);
}
.feedback {
  color: var(--color-success-text);
  font-size: var(--text-caption);
}
.feedback--error {
  color: var(--color-danger-text);
}
.settings-rows {
  display: grid;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-control-background);
}
.settings-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.75rem;
}
.settings-row + .settings-row {
  border-top: 1px solid var(--color-border);
}
@media (max-width: 38rem) {
  .settings-section {
    padding-bottom: 1.25rem;
  }
  .settings-section + .settings-section {
    padding-top: 1.25rem;
  }
  .choice-grid,
  .choice-grid--three {
    grid-template-columns: 1fr;
  }
  .default-profile-field {
    grid-template-columns: 1fr;
  }
  .history-limit-field {
    grid-template-columns: minmax(0, 1fr) 6rem;
  }
  .settings-row {
    align-items: flex-start;
  }
  .profile-actions {
    align-items: stretch;
    flex-direction: column;
  }
  .profile-actions :global(.vampire-button) {
    align-self: flex-end;
  }
}
</style>
