<script lang="ts">
import Settings2 from '@lucide/svelte/icons/settings-2';
import Save from '@lucide/svelte/icons/save';
import { untrack } from 'svelte';
import Button from '~/lib/shared/ui/Button.svelte';
import ConfirmDialog from '~/lib/shared/ui/ConfirmDialog.svelte';
import DialogActions from '~/lib/shared/ui/DialogActions.svelte';
import DialogShell from '~/lib/shared/ui/DialogShell.svelte';
import Textarea from '~/lib/shared/ui/Textarea.svelte';
import type { LaunchProfile, ManagedWorkspace } from '~/lib/shared/contracts/workspace.ts';
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
}: {
  workspace: ManagedWorkspace;
  profiles: LaunchProfile[];
  onClose: () => void;
  onSave: (startupProfileId: string | null, composerTemplate: string) => Promise<{ ok: boolean; error?: string }>;
  onManageProfiles: () => void;
} = $props();

let selectedProfileId = $state<string | null>(untrack(() => workspace.startupProfileId));
let syncedSelection = $state(untrack(() => workspace.startupProfileId));
let composerTemplate = $state(untrack(() => workspace.composerTemplate ?? DEFAULT_WORKSPACE_COMPOSER_TEMPLATE));
let syncedComposerTemplate = $state(untrack(() => workspace.composerTemplate ?? DEFAULT_WORKSPACE_COMPOSER_TEMPLATE));
let previewPrompt = $state('Review the current changes and continue the work.');
let templateElement = $state<HTMLTextAreaElement>();
let saving = $state(false);
let savingError = $state('');
let discardPrompt = $state(false);
const workspaceName = $derived(getWorkspaceName(workspace));
const templateValidationError = $derived(validateComposerTemplate(composerTemplate));
const preview = $derived(
  renderComposerTemplate(composerTemplate, previewPrompt, {
    workspace: { name: workspaceName, cwd: workspace.cwd },
  })
);
const hasUnsavedChanges = $derived(
  selectedProfileId !== syncedSelection || composerTemplate !== syncedComposerTemplate
);

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
  const start = templateElement?.selectionStart ?? composerTemplate.length;
  const end = templateElement?.selectionEnd ?? start;
  composerTemplate = `${composerTemplate.slice(0, start)}${token}${composerTemplate.slice(end)}`;
  const caret = start + token.length;
  requestAnimationFrame(() => {
    templateElement?.focus();
    templateElement?.setSelectionRange(caret, caret);
  });
}

function requestClose() {
  if (saving) return;
  if (hasUnsavedChanges) {
    discardPrompt = true;
    return;
  }
  onClose();
}

async function save() {
  if (templateValidationError) return;
  saving = true;
  savingError = '';
  try {
    const result = await onSave(selectedProfileId, composerTemplate);
    if (!result.ok) {
      savingError = result.error ?? 'Unable to save workspace settings.';
      return;
    }
    syncedSelection = selectedProfileId;
    syncedComposerTemplate = composerTemplate;
    onClose();
  } finally {
    saving = false;
  }
}
</script>

<DialogShell
  eyebrow={workspaceName}
  title="Workspace settings"
  close={requestClose}
  variant="inspect"
  closeDisabled={saving}
  footerVisible={saving || hasUnsavedChanges}
>
  {#snippet children()}
    <div class="workspace-settings-dialog">
      <section class="settings-group" aria-labelledby="composer-template-title">
        <div class="group-heading">
          <div>
            <h3 id="composer-template-title">Compose template</h3>
            <p>Wrap every message sent from Compose with instructions and workspace context.</p>
          </div>
          <span class="scope-badge">Workspace</span>
        </div>

        <label class="template-field" for="composer-template">
          <span>Template</span>
          <Textarea
            id="composer-template"
            bind:element={templateElement}
            bind:value={composerTemplate}
            rows={8}
            size="code"
            maxlength={WORKSPACE_COMPOSER_TEMPLATE_MAX_LENGTH}
            disabled={saving}
            spellcheck={false}
            ariaDescribedby="composer-template-guide composer-template-feedback"
          />
        </label>

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

        <div class="preview-grid">
          <label class="preview-input" for="composer-preview-prompt">
            <span>Preview message</span>
            <Textarea
              id="composer-preview-prompt"
              bind:value={previewPrompt}
              rows={3}
              maxlength={4_096}
              disabled={saving}
              spellcheck={false}
            />
          </label>
          <div class="preview-output">
            <div>
              <span>Sent to the shell</span>
              {#if preview.usedFallback}
                <small>Original message fallback</small>
              {/if}
            </div>
            <pre>{preview.text}</pre>
          </div>
        </div>
      </section>

      <section class="settings-group" aria-labelledby="startup-profile-title">
        <div class="group-heading profile-heading">
          <div>
            <h3 id="startup-profile-title">Startup profile</h3>
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
    </div>
  {/snippet}

  {#snippet footer()}
    <DialogActions>
      <Button variant="primary" onclick={() => void save()} disabled={saving || Boolean(templateValidationError)}>
        <Save size={15} strokeWidth={1.9} aria-hidden="true" />
        <span>{saving ? 'Saving…' : 'Save workspace settings'}</span>
      </Button>
    </DialogActions>
  {/snippet}
</DialogShell>

{#if discardPrompt}
  <ConfirmDialog
    title="Discard workspace setting changes?"
    description="Your Compose template or startup profile change has not been saved."
    confirmLabel="Discard changes"
    close={() => discardPrompt = false}
    onConfirm={async () => {
      discardPrompt = false;
      onClose();
    }}
  />
{/if}

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
.group-heading h3,
.template-field > span,
.preview-input > span,
.preview-output > div > span,
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
.template-field,
.preview-input {
  display: grid;
  gap: 0.35rem;
  min-width: 0;
}
.template-field :global(.textarea--code) {
  min-height: 9.5rem;
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
.preview-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 0.65rem;
}
.preview-input :global(textarea) {
  min-height: 8rem;
}
.preview-output {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  gap: 0.35rem;
  min-width: 0;
}
.preview-output > div {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.5rem;
}
.preview-output small {
  color: var(--color-warning-text, var(--color-text-tertiary));
  font-size: var(--text-nano);
}
.preview-output pre {
  min-height: 8rem;
  max-height: 15rem;
  margin: 0;
  padding: var(--space-4) var(--control-padding-inline-sm);
  overflow: auto;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-sm);
  background: var(--color-field-background);
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
@media (max-width: 38rem) {
  .group-heading,
  .profile-heading {
    align-items: stretch;
    flex-direction: column;
  }
  .profile-heading :global(.vampire-button) {
    align-self: flex-start;
  }
  .preview-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
