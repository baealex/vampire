<script lang="ts">
import { onMount, tick } from 'svelte';
import Send from '@lucide/svelte/icons/send';
import Button from './Button.svelte';
import DialogShell from './DialogShell.svelte';
import Field from './Field.svelte';
import Textarea from './Textarea.svelte';
import {
  WORKSPACE_AGENT_ACTION_REQUEST_MAX_LENGTH,
  type WorkspaceAgentActionDescriptor,
  type WorkspaceAgentActionSubmission,
} from '../contracts/workspace-agent-actions.ts';

let {
  close,
  load,
  submit,
  onQueued = () => undefined,
  onSubmittingChange = () => undefined,
  embedded = false,
  showTarget = true,
  showEmbeddedBack = true,
}: {
  close: () => void;
  load: () => Promise<WorkspaceAgentActionDescriptor>;
  submit: (request: string) => Promise<WorkspaceAgentActionSubmission>;
  onQueued?: (submission: WorkspaceAgentActionSubmission) => void;
  onSubmittingChange?: (submitting: boolean) => void;
  embedded?: boolean;
  showTarget?: boolean;
  showEmbeddedBack?: boolean;
} = $props();

let descriptor = $state<WorkspaceAgentActionDescriptor>();
let request = $state('');
let loading = $state(true);
let submitting = $state(false);
let errorMessage = $state('');
let requestElement = $state<HTMLTextAreaElement>();
let embeddedElement = $state<HTMLElement>();

async function loadDescriptor() {
  loading = true;
  errorMessage = '';
  try {
    descriptor = await load();
    request = descriptor.defaultRequest;
    if (embedded) {
      await tick();
      requestElement?.focus();
    }
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : 'The agent request could not be prepared.';
  } finally {
    loading = false;
  }
}

async function submitRequest() {
  if (!descriptor || !request.trim() || submitting) return;
  submitting = true;
  onSubmittingChange(true);
  errorMessage = '';
  try {
    const submission = await submit(request.trim());
    onQueued(submission);
    close();
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : 'The agent request could not be queued.';
  } finally {
    submitting = false;
    onSubmittingChange(false);
  }
}

onMount(() => {
  if (embedded) {
    void tick().then(() => embeddedElement?.focus());
  }
  void loadDescriptor();
});

function handleEmbeddedKeydown(event: KeyboardEvent) {
  if (!embedded || event.key !== 'Escape' || submitting) return;
  event.preventDefault();
  event.stopPropagation();
  close();
}
</script>

<svelte:window onkeydown={handleEmbeddedKeydown} />

{#snippet content()}
  <div class="ask-agent" aria-busy={loading}>
    {#if descriptor}
      {#if showTarget}
        <div class="ask-agent__target">
          <span>Send to</span>
          <strong>{descriptor.target.agentLabel}</strong>
          <small>{descriptor.target.workspaceLabel}</small>
        </div>
      {/if}
      <p class="ask-agent__description">{descriptor.description}</p>
      <dl class="ask-agent__context">
        {#each descriptor.context as item (item.label)}
          <div>
            <dt>{item.label}</dt>
            <dd><code>{item.value}</code></dd>
            {#if item.description}
              <small>{item.description}</small>
            {/if}
          </div>
        {/each}
      </dl>
      <Field
        label={descriptor.requestLabel}
        description="Vampire prepares the required context and sends the request to the visible main session."
      >
        <Textarea
          bind:element={requestElement}
          bind:value={request}
          rows={6}
          maxlength={WORKSPACE_AGENT_ACTION_REQUEST_MAX_LENGTH}
          placeholder={descriptor.requestPlaceholder}
          ariaLabel={descriptor.requestLabel}
          disabled={submitting}
        />
      </Field>
    {:else if loading}
      <p class="ask-agent__loading" role="status">Preparing agent context…</p>
    {/if}

    {#if errorMessage}
      <p class="ask-agent__error" role="alert">{errorMessage}</p>
    {/if}
  </div>
{/snippet}

{#snippet actions()}
  {#if !embedded || showEmbeddedBack}
    <Button variant="ghost" onclick={close} disabled={submitting}>{embedded ? 'Back' : 'Cancel'}</Button>
  {/if}
  {#if !descriptor && !loading}
    <Button variant="secondary" onclick={() => void loadDescriptor()}>Retry</Button>
  {:else}
    <Button
      variant="primary"
      onclick={() => void submitRequest()}
      disabled={!descriptor || !request.trim() || loading || submitting}
    >
      <Send size={15} strokeWidth={1.9} aria-hidden="true" />
      <span>{submitting ? 'Queuing…' : 'Send to agent'}</span>
    </Button>
  {/if}
{/snippet}

{#if embedded}
  <section bind:this={embeddedElement} class="ask-agent-embedded" tabindex="-1">
    <header>
      <span>Ask agent</span>
      <h2>{descriptor?.title ?? 'Prepare agent request'}</h2>
    </header>
    {@render content()}
    <footer>{@render actions()}</footer>
  </section>
{:else}
  <DialogShell
    eyebrow="Ask agent"
    title={descriptor?.title ?? 'Prepare agent request'}
    {close}
    closeDisabled={submitting}
    variant="form"
  >
    {#snippet children()}
      {@render content()}
    {/snippet}
    {#snippet footer()}
      {@render actions()}
    {/snippet}
  </DialogShell>
{/if}

<style>
.ask-agent {
  display: grid;
  gap: 0.85rem;
  min-width: 0;
}
.ask-agent-embedded {
  display: grid;
  gap: 1rem;
}
.ask-agent-embedded header {
  display: grid;
  gap: 0.18rem;
}
.ask-agent-embedded header span {
  color: var(--color-text-tertiary);
  font-size: var(--text-nano);
  font-weight: var(--weight-medium);
  text-transform: uppercase;
}
.ask-agent-embedded h2 {
  margin: 0;
  color: var(--color-text);
  font-size: var(--text-title);
}
.ask-agent-embedded footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}
.ask-agent__target {
  display: flex;
  align-items: baseline;
  gap: 0.42rem;
  min-width: 0;
  padding: 0.58rem 0.68rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-control);
  background: var(--color-surface-raised);
}
.ask-agent__target span,
.ask-agent__target small {
  color: var(--color-text-tertiary);
  font-size: var(--text-caption);
}
.ask-agent__target strong {
  color: var(--color-text);
  font-size: var(--text-label);
  font-weight: var(--weight-medium);
}
.ask-agent__target small {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ask-agent__description,
.ask-agent__loading,
.ask-agent__error {
  margin: 0;
  font-size: var(--text-caption);
  line-height: var(--leading-body);
}
.ask-agent__description,
.ask-agent__loading {
  color: var(--color-text-secondary);
}
.ask-agent__error {
  color: var(--color-danger-text);
}
.ask-agent__context {
  display: grid;
  gap: 0.48rem;
  margin: 0;
}
.ask-agent__context > div {
  display: grid;
  min-width: 0;
  gap: 0.18rem;
  padding: 0.55rem 0.65rem;
  border-left: 2px solid var(--color-command);
  background: var(--color-surface-raised);
}
.ask-agent__context dt {
  color: var(--color-text-tertiary);
  font-size: var(--text-nano);
  font-weight: var(--weight-medium);
}
.ask-agent__context dd {
  min-width: 0;
  margin: 0;
}
.ask-agent__context code {
  display: block;
  overflow-x: auto;
  color: var(--color-text);
  font-family: var(--font-mono);
  font-size: var(--text-caption);
  white-space: nowrap;
}
.ask-agent__context small {
  color: var(--color-text-tertiary);
  font-size: var(--text-nano);
  line-height: var(--leading-ui);
}
</style>
