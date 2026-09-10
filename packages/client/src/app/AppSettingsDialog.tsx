import { Clock3, LayoutDashboard, LogOut, Plus, Save, Trash2 } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useMemo, useState } from 'react';
import {
  loadTerminalFontSize,
  MAXIMUM_TERMINAL_FONT_SIZE,
  MINIMUM_TERMINAL_FONT_SIZE,
  saveTerminalFontSize,
} from '@vampire/lib/features/terminal/model/terminal-display-preference.ts';
import { MAX_LAUNCH_PROFILES } from '@vampire/lib/shared/contracts/launch-profiles.ts';
import {
  MAX_WORKSPACE_COMPOSER_PROMPTS,
  MIN_WORKSPACE_COMPOSER_PROMPTS,
} from '@vampire/lib/shared/contracts/workspace-composer-history.ts';
import type { LaunchProfile } from '@vampire/lib/shared/contracts/workspace.ts';
import type { WorkspaceState } from '~/features/workspace/model/workspace-state.ts';
import { useTheme, type AppThemePreference } from '~/shared/theme/theme.ts';
import { Button, Input, ManagementSurface, Select } from '~/shared/ui/index.ts';
import './app-settings-dialog.css';

function copyProfiles(profiles: LaunchProfile[]) {
  return profiles.map((profile) => ({ ...profile }));
}

export const AppSettingsDialog = observer(function AppSettingsDialog({
  onClose,
  onLogout,
  onManageAutomations,
  onManageWidgets,
  state,
}: {
  onClose: () => void;
  onLogout?: () => void;
  onManageAutomations: () => void;
  onManageWidgets: () => void;
  state: WorkspaceState;
}) {
  const theme = useTheme();
  const [fontSize, setFontSize] = useState(() => loadTerminalFontSize(14));
  const [profiles, setProfiles] = useState(() => copyProfiles(state.launchProfiles));
  const [defaultId, setDefaultId] = useState(state.defaultStartupProfileId ?? '');
  const [historyEnabled, setHistoryEnabled] = useState(state.composerHistorySettings.enabled);
  const [historyLimit, setHistoryLimit] = useState(String(state.composerHistorySettings.limit));
  const [savingProfiles, setSavingProfiles] = useState(false);
  const [savingHistory, setSavingHistory] = useState(false);
  const [profileFeedback, setProfileFeedback] = useState('');
  const [historyFeedback, setHistoryFeedback] = useState('');
  const profileDirty = useMemo(
    () =>
      JSON.stringify(profiles) !== JSON.stringify(state.launchProfiles) ||
      defaultId !== (state.defaultStartupProfileId ?? ''),
    [defaultId, profiles, state.defaultStartupProfileId, state.launchProfiles]
  );
  const historyDirty =
    historyEnabled !== state.composerHistorySettings.enabled ||
    Number(historyLimit) !== state.composerHistorySettings.limit;
  const updateProfile = (index: number, changes: Partial<LaunchProfile>) =>
    setProfiles((current) =>
      current.map((profile, position) => (position === index ? { ...profile, ...changes } : profile))
    );
  const addProfile = () => {
    if (profiles.length >= MAX_LAUNCH_PROFILES) return;
    const id = crypto.randomUUID();
    setProfiles((current) => [...current, { id, name: `Profile ${current.length + 1}`, command: '' }]);
    if (!defaultId) setDefaultId(id);
  };
  const removeProfile = (id: string) => {
    setProfiles((current) => current.filter((profile) => profile.id !== id));
    if (defaultId === id) setDefaultId('');
  };
  const saveProfiles = async () => {
    const cleaned = profiles.map((profile) => ({
      ...profile,
      name: profile.name.trim(),
      command: profile.command.trim(),
    }));
    const names = new Set<string>();
    for (const profile of cleaned) {
      if (!profile.name || !profile.command) {
        setProfileFeedback('Give every launch profile a name and command.');
        return;
      }
      const name = profile.name.toLocaleLowerCase();
      if (names.has(name)) {
        setProfileFeedback('Launch profile names must be unique.');
        return;
      }
      if (/\0|\r|\n|\t/.test(profile.name + profile.command)) {
        setProfileFeedback('Names and commands must stay on one line.');
        return;
      }
      names.add(name);
    }
    setSavingProfiles(true);
    setProfileFeedback('');
    const applyDefaultToAll = defaultId !== (state.defaultStartupProfileId ?? '');
    const result = await state.updateLaunchProfileSettings(cleaned, defaultId || null, applyDefaultToAll);
    setSavingProfiles(false);
    if (result.ok) {
      setProfiles(copyProfiles(state.launchProfiles));
      setProfileFeedback(
        applyDefaultToAll
          ? `Default updated for ${state.workspaces.length} workspace${state.workspaces.length === 1 ? '' : 's'}.`
          : 'Launch profiles saved.'
      );
    } else setProfileFeedback(result.error ?? 'Unable to save launch profiles.');
  };
  const saveHistory = async () => {
    const limit = Number(historyLimit);
    if (!Number.isInteger(limit) || limit < MIN_WORKSPACE_COMPOSER_PROMPTS || limit > MAX_WORKSPACE_COMPOSER_PROMPTS) {
      setHistoryFeedback(
        `Keep between ${MIN_WORKSPACE_COMPOSER_PROMPTS} and ${MAX_WORKSPACE_COMPOSER_PROMPTS} prompts per workspace.`
      );
      return;
    }
    setSavingHistory(true);
    setHistoryFeedback('');
    const result = await state.updateComposerHistorySettings({ enabled: historyEnabled, limit });
    setSavingHistory(false);
    setHistoryFeedback(
      result.ok
        ? historyEnabled
          ? `Composer history will keep ${limit} prompts per workspace.`
          : 'Composer history is off. Existing history is retained.'
        : (result.error ?? 'Unable to save Composer history settings.')
    );
  };
  return (
    <Dialog open title="Settings" onClose={onClose}>
      <div className="app-settings">
        <SettingsSection title="Appearance" scope="Browser" description="Saved in this browser.">
          <div className="theme-options" role="radiogroup" aria-label="Theme">
            {(
              [
                { value: 'system', label: 'System', detail: 'Follow this device' },
                { value: 'dark', label: 'Dark', detail: 'Always dark' },
                { value: 'light', label: 'Light', detail: 'Always light' },
              ] as Array<{ value: AppThemePreference; label: string; detail: string }>
            ).map((option) => (
              <label key={option.value} className={theme.preference === option.value ? 'active' : ''}>
                <input
                  type="radio"
                  name="theme"
                  checked={theme.preference === option.value}
                  onChange={() => theme.setPreference(option.value)}
                />
                <span>
                  <strong>{option.label}</strong>
                  <small>{option.detail}</small>
                </span>
              </label>
            ))}
          </div>
          <label className="setting-row">
            <span>
              <strong>Terminal text size</strong>
              <small>Applies when you open or return to a terminal.</small>
            </span>
            <Select
              aria-label="Terminal text size"
              value={fontSize}
              onChange={(event) => {
                const next = Number(event.currentTarget.value);
                if (saveTerminalFontSize(next)) setFontSize(next);
              }}
            >
              {Array.from(
                { length: MAXIMUM_TERMINAL_FONT_SIZE - MINIMUM_TERMINAL_FONT_SIZE + 1 },
                (_, index) => MINIMUM_TERMINAL_FONT_SIZE + index
              ).map((size) => (
                <option key={size} value={size}>
                  {size}px
                </option>
              ))}
            </Select>
          </label>
        </SettingsSection>
        <SettingsSection
          title="Composer history"
          scope="Server"
          description="Only successfully sent Compose prompts are saved; direct terminal input is never recorded."
        >
          <label className="setting-row">
            <input
              type="checkbox"
              checked={historyEnabled}
              onChange={(event) => setHistoryEnabled(event.currentTarget.checked)}
            />
            <span>
              <strong>Save Compose history</strong>
              <small>Make recent prompts available for reuse.</small>
            </span>
          </label>
          <label className="setting-row">
            <span>
              <strong>Prompts per workspace</strong>
              <small>Lowering this limit removes the oldest prompts.</small>
            </span>
            <Input
              type="number"
              min={MIN_WORKSPACE_COMPOSER_PROMPTS}
              max={MAX_WORKSPACE_COMPOSER_PROMPTS}
              value={historyLimit}
              onChange={(event) => setHistoryLimit(event.currentTarget.value)}
              disabled={!historyEnabled}
              aria-label="Prompts saved per workspace"
            />
          </label>
          <ActionRow feedback={historyFeedback}>
            <Button
              size="sm"
              variant="primary"
              disabled={!historyDirty || savingHistory}
              onClick={() => void saveHistory()}
            >
              <Save size={15} aria-hidden="true" />
              {savingHistory ? 'Saving…' : 'Save history settings'}
            </Button>
          </ActionRow>
        </SettingsSection>
        <SettingsSection
          title="Launch profiles"
          scope="Server"
          description="Profiles are shared by every workspace on this server."
          action={
            <Button size="sm" onClick={addProfile} disabled={profiles.length >= MAX_LAUNCH_PROFILES}>
              <Plus size={15} aria-hidden="true" />
              Add profile
            </Button>
          }
        >
          <label className="setting-row">
            <span>
              <strong>Default for all workspaces</strong>
              <small>Changing this updates registered workspaces; running shells are unchanged.</small>
            </span>
            <Select value={defaultId} onChange={(event) => setDefaultId(event.currentTarget.value)}>
              <option value="">No startup profile</option>
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name || 'Unnamed profile'}
                </option>
              ))}
            </Select>
          </label>
          <div className="profile-list">
            {profiles.map((profile, index) => (
              <article className="profile-card" key={profile.id}>
                <label>
                  <span>Name</span>
                  <Input
                    size="sm"
                    value={profile.name}
                    maxLength={80}
                    onChange={(event) => updateProfile(index, { name: event.currentTarget.value })}
                  />
                </label>
                <Button
                  variant="danger-outline"
                  size="sm"
                  aria-label={`Remove ${profile.name || 'profile'}`}
                  onClick={() => removeProfile(profile.id)}
                >
                  <Trash2 size={15} aria-hidden="true" />
                </Button>
                <label className="profile-command">
                  <span>Command</span>
                  <Input
                    size="sm"
                    mono
                    value={profile.command}
                    maxLength={1000}
                    onChange={(event) => updateProfile(index, { command: event.currentTarget.value })}
                  />
                </label>
              </article>
            ))}
          </div>
          <ActionRow feedback={profileFeedback}>
            <Button
              size="sm"
              variant="primary"
              disabled={!profileDirty || savingProfiles}
              onClick={() => void saveProfiles()}
            >
              <Save size={15} aria-hidden="true" />
              {savingProfiles ? 'Saving…' : 'Save profiles'}
            </Button>
          </ActionRow>
        </SettingsSection>
        <SettingsSection title="Server tools" scope="Server" description="Manage server-wide utilities from one place.">
          <div className="setting-row">
            <span>
              <strong>Automations</strong>
              <small>Review scheduled prompts across workspaces.</small>
            </span>
            <Button size="sm" onClick={onManageAutomations}>
              <Clock3 size={15} aria-hidden="true" />
              Manage all automations
            </Button>
          </div>
          <div className="setting-row">
            <span>
              <strong>Status widgets</strong>
              <small>Configure information shown above terminals.</small>
            </span>
            <Button size="sm" onClick={onManageWidgets}>
              <LayoutDashboard size={15} aria-hidden="true" />
              Manage status widgets
            </Button>
          </div>
        </SettingsSection>
        {onLogout ? (
          <SettingsSection title="Session" scope="Browser" description="End authentication for this browser.">
            <Button variant="danger-outline" onClick={onLogout}>
              <LogOut size={16} aria-hidden="true" />
              Sign out
            </Button>
          </SettingsSection>
        ) : null}
      </div>
    </Dialog>
  );
});

function SettingsSection({
  action,
  children,
  description,
  scope,
  title,
}: React.PropsWithChildren<{ action?: React.ReactNode; description: string; scope: string; title: string }>) {
  return (
    <section className="settings-section">
      <header>
        <div>
          <div>
            <h2>{title}</h2>
            <span>{scope}</span>
          </div>
          <p>{description}</p>
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}
function ActionRow({ children, feedback }: React.PropsWithChildren<{ feedback: string }>) {
  return (
    <div className="settings-action">
      <p role="status">{feedback}</p>
      {children}
    </div>
  );
}

function Dialog({ children, onClose }: React.PropsWithChildren<{ open: boolean; onClose: () => void; title: string }>) {
  const meta = /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
  return (
    <ManagementSurface
      title="Settings"
      titleId="application-settings-title"
      eyebrow="Vampire"
      close={onClose}
      closeLabel="Close settings"
    >
      {children}
      <section className="settings-section">
        <header>
          <div>
            <div>
              <h2>Keyboard shortcuts</h2>
              <span>Desktop</span>
            </div>
            <p>Each workspace remembers its input surface, draft, and editing position.</p>
          </div>
        </header>
        <div className="shortcut-list" aria-label="Keyboard shortcuts">
          <Shortcut
            title="Switch input"
            description="Move between Compose and direct terminal input."
            keys={meta ? ['⌘', '/'] : ['Ctrl', '`']}
          />
          <Shortcut
            title="Composer history"
            description="Open saved prompts from Compose."
            keys={['Ctrl', 'Alt', 'H']}
          />
          <Shortcut
            title="Literal slash"
            description="Insert a slash without handing off to the terminal."
            keys={['Ctrl', '/']}
          />
        </div>
      </section>
    </ManagementSurface>
  );
}

function Shortcut({ description, keys, title }: { description: string; keys: string[]; title: string }) {
  return (
    <div className="shortcut-row">
      <span className="shortcut-description">
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      <span className="shortcut-keys">
        {keys.map((key) => (
          <kbd key={key}>{key}</kbd>
        ))}
      </span>
    </div>
  );
}
