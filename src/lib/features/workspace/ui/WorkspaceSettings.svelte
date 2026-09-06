<script lang="ts">
import Eye from '@lucide/svelte/icons/eye';
import Settings2 from '@lucide/svelte/icons/settings-2';
import Save from '@lucide/svelte/icons/save';
import { untrack } from 'svelte';
import Button from '~/lib/shared/ui/Button.svelte';
import CodeEditor from '~/lib/shared/ui/CodeEditor.svelte';
import Input from '~/lib/shared/ui/Input.svelte';
import ManagementSurface from '~/lib/shared/ui/ManagementSurface.svelte';
import {
  WORKSPACE_ALIAS_MAX_LENGTH,
  type LaunchProfile,
  type ManagedWorkspace,
} from '~/lib/shared/contracts/workspace.ts';
import {
  DEFAULT_WORKSPACE_COMPOSER_TEMPLATE,
  WORKSPACE_COMPOSER_TEMPLATE_MAX_LENGTH,
} from '~/lib/shared/contracts/workspace-composer-template.ts';
import {
  COMPOSER_TEMPLATE_VARIABLES,
  renderComposerTemplate,
  validateComposerTemplate,
} from '~/lib/shared/lib/composer-template.ts';
import { workspaceName as getWorkspaceName } from '../model/workspace-view.ts';

let {
  workspace,
  profiles,
  onClose,
  onSave,
  onManageProfiles,
  onBusyChange = () => undefined,
  onDirtyChange = () => undefined,
}: {
  workspace: ManagedWorkspace;
  profiles: LaunchProfile[];
  onClose: () => void;
  onSave: (
    workspaceLabel: string,
    startupProfileId: string | null,
    composerTemplate: string
  ) => Promise<{ ok: boolean; error?: string }>;
  onManageProfiles: () => void;
  onBusyChange?: (busy: boolean) => void;
  onDirtyChange?: (dirty: boolean) => void;
} = $props();

let workspaceLabel = $state(untrack(() => workspace.workspaceLabel?.trim() ?? ''));
let syncedWorkspaceLabel = $state(untrack(() => workspace.workspaceLabel?.trim() ?? ''));
let selectedProfileId = $state<string | null>(untrack(() => workspace.startupProfileId));
let syncedSelection = $state(untrack(() => workspace.startupProfileId));
let composerTemplate = $state(untrack(() => workspace.composerTemplate ?? DEFAULT_WORKSPACE_COMPOSER_TEMPLATE));
let syncedComposerTemplate = $state(untrack(() => workspace.composerTemplate ?? DEFAULT_WORKSPACE_COMPOSER_TEMPLATE));
let previewOpen = $state(false);
let templateEditor = $state<{ focus: () => void; insert: (text: string) => void }>();
let saving = $state(false);
let savingError = $state('');
let savedMessage = $state('');
const workspaceName = $derived(getWorkspaceName(workspace));
const previewWorkspaceName = $derived(getWorkspaceName({ ...workspace, workspaceLabel: workspaceLabel.trim() }));
const aliasValidationError = $derived(
  /[\0\r\n\t]/.test(workspaceLabel) || workspaceLabel.trim().length > WORKSPACE_ALIAS_MAX_LENGTH
    ? `Aliases must stay on one line and be ${WORKSPACE_ALIAS_MAX_LENGTH} characters or fewer.`
    : ''
);
const templateValidationError = $derived(validateComposerTemplate(composerTemplate));
const preview = $derived(
  renderComposerTemplate(composerTemplate, '[Your message]', {
    workspace: { name: previewWorkspaceName, cwd: workspace.cwd },
  })
);
const hasUnsavedChanges = $derived(
  workspaceLabel.trim() !== syncedWorkspaceLabel ||
    selectedProfileId !== syncedSelection ||
    composerTemplate !== syncedComposerTemplate
);

$effect(() => onBusyChange(saving));
$effect(() => onDirtyChange(hasUnsavedChanges));
$effect(() => {
  if (hasUnsavedChanges) savedMessage = '';
});

$effect(() => {
  const incoming = workspace.workspaceLabel?.trim() ?? '';
  if (incoming === syncedWorkspaceLabel) return;
  if (untrack(() => workspaceLabel.trim()) !== syncedWorkspaceLabel) return;
  workspaceLabel = incoming;
  syncedWorkspaceLabel = incoming;
});

$effect(() => {
  const incoming = workspace.startupProfileId;
  if (incoming === syncedSelection) return;
  if (untrack(() => selectedProfileId) !== syncedSelection) return;
  selectedProfileId = incoming;
  syncedSelection = incoming;
});

$effect(() => {
  const incoming = workspace.composerTemplate ?? DEFAULT_WORKSPACE_COMPOSER_TEMPLATE;
  if (incoming === syncedComposerTemplate) return;
  if (untrack(() => composerTemplate) !== syncedComposerTemplate) return;
  composerTemplate = incoming;
  syncedComposerTemplate = incoming;
});

$effect(() => {
  if (selectedProfileId && !profiles.some((profile) => profile.id === selectedProfileId)) {
    selectedProfileId = null;
  }
});

function insertVariable(token: string) {
  if (templateEditor) templateEditor.insert(token);
  else composerTemplate += token;
}

async function save() {
  if (templateValidationError || aliasValidationError) return;
  saving = true;
  savingError = '';
  savedMessage = '';
  try {
    const normalizedWorkspaceLabel = workspaceLabel.trim();
    const result = await onSave(normalizedWorkspaceLabel, selectedProfileId, composerTemplate);
    if (!result.ok) {
      savingError = result.error ?? 'Unable to save workspace settings.';
      return;
    }
    workspaceLabel = normalizedWorkspaceLabel;
    syncedWorkspaceLabel = normalizedWorkspaceLabel;
    syncedSelection = selectedProfileId;
    syncedComposerTemplate = composerTemplate;
    savedMessage = 'Workspace settings saved.';
  } finally {
    saving = false;
  }
}
</script>

<ManagementSurface
  eyebrow={workspaceName}
  title="Workspace settings"
  titleId="workspace-settings-title"
  close={onClose}
  closeLabel="Close workspace settings"
  busy={saving}
>
  {#snippet children()}
    <div class="workspace-settings-dialog">
      <section class="settings-group" aria-labelledby="workspace-identity-title">
        <div class="group-heading">
          <div>
            <h2 id="workspace-identity-title">Identity</h2>
            <p>Choose the name Vampire shows without changing the project folder.</p>
          </div>
          <span class="scope-badge">Workspace</span>
        </div>

        <label class="alias-field" for="workspace-alias">
          <span>Alias</span>
          <Input
            id="workspace-alias"
            bind:value={workspaceLabel}
            maxlength={WORKSPACE_ALIAS_MAX_LENGTH}
            placeholder="Use folder name"
            disabled={saving}
            autocomplete="off"
            ariaDescribedby="workspace-alias-help"
          />
        </label>
        <p id="workspace-alias-help" class="field-help">
          Leave empty to use the folder name. Each worktree keeps its own workspace name.
        </p>
        {#if aliasValidationError}
          <p class="feedback" role="alert">{aliasValidationError}</p>
        {/if}
        <div class="workspace-path">
          <span>Directory</span>
          <code>{workspace.cwd}</code>
        </div>
      </section>

      <section class="settings-group" aria-labelledby="composer-template-title">
        <div class="group-heading">
          <div>
            <h2 id="composer-template-title">Compose template</h2>
            <p>Wrap every message sent from Compose with instructions and workspace context.</p>
          </div>
          <span class="scope-badge">Workspace</span>
        </div>

        <div class="variable-guide" id="composer-template-guide">
          <div>
            <strong>Insert a variable</strong>
            <p>Only these variables are supported. Prompt must appear exactly once.</p>
          </div>
          <div class="variable-buttons" role="group" aria-label="Insert a template variable">
            {#each COMPOSER_TEMPLATE_VARIABLES as variable (variable.token)}
              <button
                type="button"
                onclick={() => insertVariable(variable.token)}
                disabled={saving}
                title={variable.description}
              >
                <span>{variable.label}</span>
                <code>{variable.token}</code>
              </button>
            {/each}
          </div>
        </div>

        <div class="template-column">
          <div class="template-field">
            <div class="template-field-heading">
              <span>Template source</span>
              <small
                >{composerTemplate.length.toLocaleString()}
                / {WORKSPACE_COMPOSER_TEMPLATE_MAX_LENGTH.toLocaleString()}</small
              >
            </div>
            <CodeEditor
              value={composerTemplate}
              ariaLabel="Template source"
              placeholder={'Write the instructions wrapped around {{ prompts }}'}
              maxlength={WORKSPACE_COMPOSER_TEMPLATE_MAX_LENGTH}
              disabled={saving}
              compact
              onReady={(controller) => templateEditor = controller}
              onValueChange={(value) => composerTemplate = value}
            />
          </div>

          <div id="composer-template-feedback">
            {#if templateValidationError}
              <p class="feedback" role="alert">
                {templateValidationError}
                The original Compose message is always used as a safe fallback.
              </p>
            {:else if preview.error}
              <p class="feedback" role="alert">{preview.error}</p>
            {/if}
          </div>

          <div class="preview-control">
            <Button
              variant="secondary"
              size="sm"
              ariaExpanded={previewOpen}
              ariaControls="composer-template-preview"
              onclick={() => previewOpen = !previewOpen}
            >
              <Eye size={15} strokeWidth={1.8} aria-hidden="true" />
              <span>{previewOpen ? 'Hide preview' : 'Preview'}</span>
            </Button>
          </div>

          {#if previewOpen}
            <div id="composer-template-preview" class="preview-output" role="region" aria-label="Template preview">
              <pre>{preview.text}</pre>
            </div>
          {/if}
        </div>
      </section>

      <section class="settings-group" aria-labelledby="startup-profile-title">
        <div class="group-heading profile-heading">
          <div>
            <h2 id="startup-profile-title">Startup profile</h2>
            <p>The selected command runs the next time this shell is opened. Running terminals are not changed.</p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onclick={onManageProfiles}
            disabled={saving || hasUnsavedChanges}
            title={hasUnsavedChanges ? 'Save or discard workspace changes before managing shared profiles.' : undefined}
          >
            <Settings2 size={15} strokeWidth={1.8} aria-hidden="true" />
            <span>Manage</span>
          </Button>
        </div>

        <div class="profile-options" role="radiogroup" aria-label="Startup profile">
          <label class:selected={selectedProfileId === null} class="profile-option">
            <input
              type="radio"
              name="startup-profile"
              checked={selectedProfileId === null}
              onchange={() => selectedProfileId = null}
            >
            <span>
              <strong>No startup profile</strong>
              <small>Open a regular shell without running a saved command.</small>
            </span>
          </label>

          {#each profiles as profile (profile.id)}
            <label class:selected={selectedProfileId === profile.id} class="profile-option">
              <input
                type="radio"
                name="startup-profile"
                checked={selectedProfileId === profile.id}
                onchange={() => selectedProfileId = profile.id}
              >
              <span>
                <strong>{profile.name}</strong>
                <code>{profile.command}</code>
              </span>
            </label>
          {/each}
        </div>

        {#if profiles.length === 0}
          <p class="empty-message">Create a shared launch profile in Settings to make it available here.</p>
        {/if}
      </section>

      {#if savingError}
        <p class="feedback" role="alert">{savingError}</p>
      {/if}
      {#if savedMessage}
        <p class="saved-message" role="status">{savedMessage}</p>
      {/if}
    </div>
  {/snippet}

  {#snippet footer()}
    <div class="settings-actions">
      <Button
        variant="primary"
        onclick={() => void save()}
        disabled={saving || !hasUnsavedChanges || Boolean(templateValidationError) || Boolean(aliasValidationError)}
      >
        <Save size={15} strokeWidth={1.9} aria-hidden="true" />
        <span>{saving ? 'Saving…' : 'Save workspace settings'}</span>
      </Button>
    </div>
  {/snippet}
</ManagementSurface>

<style>
.workspace-settings-dialog {
  display: grid;
  gap: 1rem;
  min-width: 0;
}
.settings-group {
  display: grid;
  gap: 0.75rem;
  min-width: 0;
  padding: 0.85rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
}
.group-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
}
.group-heading h2,
.alias-field > span,
.template-field-heading > span,
.variable-guide strong {
  margin: 0;
  color: var(--color-text);
  font-size: var(--text-label);
  font-weight: var(--weight-medium);
}
.group-heading p,
.variable-guide p {
  max-width: 39rem;
  margin: 0.2rem 0 0;
  color: var(--color-text-secondary);
  font-size: var(--text-caption);
  line-height: var(--leading-body);
}
.scope-badge {
  flex: 0 0 auto;
  padding: 0.2rem 0.45rem;
  border-radius: 999px;
  background: var(--color-control-background);
  color: var(--color-text-tertiary);
  font-size: var(--text-nano);
}
.alias-field {
  display: grid;
  gap: 0.35rem;
  min-width: 0;
}
.field-help {
  margin: -0.2rem 0 0;
  color: var(--color-text-tertiary);
  font-size: var(--text-nano);
  line-height: var(--leading-ui);
}
.workspace-path {
  display: grid;
  gap: 0.28rem;
  min-width: 0;
  padding: 0.65rem 0.75rem;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-sm);
  background: var(--color-control-background);
}
.workspace-path span {
  color: var(--color-text-tertiary);
  font-size: var(--text-nano);
}
.workspace-path code {
  min-width: 0;
  overflow: hidden;
  color: var(--color-text-secondary);
  font-family: var(--font-mono);
  font-size: var(--text-caption);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.template-field {
  display: grid;
  gap: 0.35rem;
  min-width: 0;
}
.template-field-heading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
}
.template-field-heading small {
  color: var(--color-text-tertiary);
  font-family: var(--font-mono);
  font-size: var(--text-nano);
}
.template-column {
  display: grid;
  gap: var(--space-3);
  min-width: 0;
}
.variable-guide {
  display: grid;
  gap: 0.55rem;
}
.variable-buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}
.variable-buttons button {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  min-height: 2rem;
  padding: 0.25rem 0.55rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-control-background);
  color: var(--color-text-secondary);
  font: inherit;
  font-size: var(--text-caption);
  cursor: pointer;
}
.variable-buttons button:hover:not(:disabled) {
  border-color: var(--color-visual-accent-border);
  background: var(--color-surface-hover);
}
.variable-buttons button:focus-visible {
  outline: none;
  box-shadow: var(--shadow-accent-focus);
}
.variable-buttons button:disabled {
  cursor: wait;
  opacity: 0.62;
}
.variable-buttons code {
  color: var(--color-text-tertiary);
  font-family: var(--font-mono);
  font-size: var(--text-nano);
}
.preview-control {
  display: flex;
}
.preview-output {
  min-width: 0;
}
.preview-output pre {
  max-height: 12rem;
  margin: 0;
  padding: var(--space-4) var(--control-padding-inline-sm);
  overflow: auto;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-code-background);
  color: var(--color-text);
  font-family: var(--font-mono);
  font-size: var(--text-caption);
  line-height: 1.45;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.profile-heading :global(.vampire-button) {
  flex: 0 0 auto;
  white-space: nowrap;
}
.profile-options {
  display: grid;
  gap: 0.55rem;
}
.profile-option {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: start;
  gap: 0.65rem;
  padding: 0.75rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-control-background);
  cursor: pointer;
}
.profile-option.selected {
  border-color: var(--color-visual-accent-border);
  background: var(--color-surface-selected);
}
.profile-option input {
  margin-top: 0.18rem;
  accent-color: var(--color-accent);
}
.profile-option input:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}
.profile-option > span {
  display: grid;
  min-width: 0;
  gap: 0.25rem;
}
.profile-option strong {
  color: var(--color-text);
  font-size: var(--text-caption);
  font-weight: var(--weight-medium);
}
.profile-option small,
.profile-option code {
  overflow: hidden;
  color: var(--color-text-tertiary);
  font-size: var(--text-nano);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.profile-option code {
  font-family: var(--font-mono);
}
.empty-message,
.feedback {
  margin: 0;
  padding: 0.65rem 0.75rem;
  border-radius: var(--radius-sm);
  font-size: var(--text-caption);
  line-height: var(--leading-body);
}
.empty-message {
  background: var(--color-control-background);
  color: var(--color-text-tertiary);
}
.feedback {
  background: var(--color-danger-surface-hover);
  color: var(--color-danger-text);
}
.saved-message {
  margin: 0;
  padding: 0.65rem 0.75rem;
  border-radius: var(--radius-sm);
  background: var(--color-success-surface);
  color: var(--color-success-text);
  font-size: var(--text-caption);
  line-height: var(--leading-body);
}
.settings-actions {
  display: flex;
  justify-content: flex-end;
}
@media (max-width: 38rem) {
  .group-heading,
  .profile-heading {
    align-items: stretch;
    flex-direction: column;
  }
  .scope-badge {
    align-self: flex-start;
  }
  .profile-heading :global(.vampire-button) {
    align-self: flex-start;
  }
}
</style>
