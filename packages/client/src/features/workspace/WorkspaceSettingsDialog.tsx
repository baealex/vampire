import { workspaceName } from '@vampire/lib/features/workspace/model/workspace-view.ts';
import type { ManagedWorkspace } from '@vampire/lib/shared/contracts/workspace.ts';
import { DEFAULT_WORKSPACE_COMPOSER_TEMPLATE } from '@vampire/lib/shared/contracts/workspace-composer-template.ts';
import { renderComposerTemplate, validateComposerTemplate } from '@vampire/lib/shared/lib/composer-template.ts';
import { Eye, Save, Settings2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { CodeEditor } from '~/shared/ui/CodeEditor.tsx';
import { Button, Input, ManagementSurface } from '~/shared/ui/index.ts';
import type { WorkspaceState } from './model/workspace-state.ts';
import './workspace-settings.css';

export function WorkspaceSettingsDialog({
  onClose,
  onManageProfiles,
  state,
  workspace,
}: {
  onClose: () => void;
  onManageProfiles?: () => void;
  state: WorkspaceState;
  workspace: ManagedWorkspace;
}) {
  const initialLabel = workspace.workspaceLabel?.trim() ?? '';
  const initialProfile = workspace.startupProfileId ?? '';
  const initialTemplate = workspace.composerTemplate ?? DEFAULT_WORKSPACE_COMPOSER_TEMPLATE;
  const [label, setLabel] = useState(initialLabel);
  const [profile, setProfile] = useState(initialProfile);
  const [template, setTemplate] = useState(initialTemplate);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [synced, setSynced] = useState({ label: initialLabel, profile: initialProfile, template: initialTemplate });
  const dirty = label.trim() !== synced.label || profile !== synced.profile || template !== synced.template;
  const validation = validateComposerTemplate(template);
  const preview = useMemo(
    () =>
      renderComposerTemplate(template, '[Your message]', {
        workspace: { cwd: workspace.cwd, name: label.trim() || workspaceName(workspace) },
      }),
    [label, template, workspace],
  );
  const save = async () => {
    if (validation) return;
    setSaving(true);
    setError('');
    setSaved('');
    const normalized = label.trim();
    const normalizedTemplate = template.replace(/\r\n?/g, '\n');
    const result = await state.updateWorkspaceSettings(workspace.id, normalized, profile || null, normalizedTemplate);
    setSaving(false);
    if (result.ok) {
      setLabel(normalized);
      setTemplate(normalizedTemplate);
      setSynced({ label: normalized, profile, template: normalizedTemplate });
      setSaved('Workspace settings saved.');
    } else setError(result.error ?? 'Unable to save workspace settings.');
  };
  return (
    <ManagementSurface
      title="Workspace settings"
      titleId="workspace-settings-title"
      eyebrow={workspaceName(workspace)}
      close={onClose}
      closeLabel="Close workspace settings"
      busy={saving}
      dirty={dirty}
      footer={
        <div className="settings-actions">
          <Button variant="primary" disabled={saving || !dirty || Boolean(validation)} onClick={() => void save()}>
            <Save size={15} />
            {saving ? 'Saving…' : 'Save workspace settings'}
          </Button>
        </div>
      }
    >
      <div className="workspace-settings-page">
        <section className="workspace-setting-group" aria-labelledby="workspace-identity-title">
          <header>
            <div>
              <h2 id="workspace-identity-title">Identity</h2>
              <p>Choose the name Vampire shows without changing the project folder.</p>
            </div>
            <span>Workspace</span>
          </header>
          <label>
            Alias
            <Input
              value={label}
              onChange={(event) => {
                setLabel(event.currentTarget.value);
                setSaved('');
              }}
              placeholder="Use folder name"
            />
          </label>
          <small>Leave empty to use the folder name. Each worktree keeps its own workspace name.</small>
          <div className="workspace-path">
            <span>Directory</span>
            <code>{workspace.cwd}</code>
          </div>
        </section>
        <section className="workspace-setting-group" aria-labelledby="composer-template-title">
          <header>
            <div>
              <h2 id="composer-template-title">Compose template</h2>
              <p>Wrap every message sent from Compose with instructions and workspace context.</p>
            </div>
            <span>Workspace</span>
          </header>
          <div className="template-field">
            <div>
              <span>Template source</span>
              <small>{template.length.toLocaleString()}</small>
            </div>
            <CodeEditor
              label="Template source"
              language="plaintext"
              value={template}
              onChange={(value) => {
                setTemplate(value);
                setSaved('');
              }}
            />
          </div>
          {validation ? (
            <p role="alert" className="repository-error">
              {validation} The original Compose message is always used as a safe fallback.
            </p>
          ) : null}
          <Button size="sm" onClick={() => setPreviewOpen((open) => !open)}>
            <Eye size={15} />
            {previewOpen ? 'Hide preview' : 'Preview'}
          </Button>
          {previewOpen ? (
            <div className="preview-output" role="region" aria-label="Template preview">
              <pre>{preview.text}</pre>
            </div>
          ) : null}
        </section>
        <section className="workspace-setting-group" aria-labelledby="startup-profile-title">
          <header>
            <div>
              <h2 id="startup-profile-title">Startup profile</h2>
              <p>The selected command runs the next time this shell is opened.</p>
            </div>
            {onManageProfiles ? (
              <Button size="sm" onClick={onManageProfiles} disabled={dirty}>
                <Settings2 size={15} />
                Manage
              </Button>
            ) : null}
          </header>
          <div className="profile-options" role="radiogroup" aria-label="Startup profile">
            <label>
              <input type="radio" name="startup-profile" checked={!profile} onChange={() => setProfile('')} />
              <span>
                <strong>No startup profile</strong>
                <small>Open a regular shell without running a saved command.</small>
              </span>
            </label>
            {state.launchProfiles.map((item) => (
              <label key={item.id}>
                <input
                  type="radio"
                  name="startup-profile"
                  checked={profile === item.id}
                  onChange={() => setProfile(item.id)}
                />
                <span>
                  <strong>{item.name}</strong>
                  <code>{item.command}</code>
                </span>
              </label>
            ))}
          </div>
        </section>
        {error ? (
          <p role="alert" className="repository-error">
            {error}
          </p>
        ) : null}
        {saved ? (
          <p role="status" className="saved-message">
            {saved}
          </p>
        ) : null}
      </div>
    </ManagementSurface>
  );
}
