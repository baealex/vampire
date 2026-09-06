<script lang="ts">
import type { RecoverableComposerSubmission } from '../model/composer-submission.ts';

let {
  submissions,
  restore,
  dismiss,
}: {
  submissions: RecoverableComposerSubmission[];
  restore: (submission: RecoverableComposerSubmission) => void;
  dismiss: (requestId: string) => void;
} = $props();
</script>

{#if submissions.length > 0}
  <section class="submission-recovery" aria-label="Compose delivery status">
    {#each submissions as submission (submission.requestId)}
      <article class:pending={submission.status === 'pending'}>
        <div class="submission-copy">
          <strong>
            {submission.status === 'pending'
              ? 'Sending message…'
              : submission.status === 'failed'
                ? 'Message submission failed'
                : 'Delivery could not be confirmed'}
          </strong>
          {#if submission.status === 'pending'}
            <span class="submission-detail">{submission.message ?? 'Waiting for the terminal to accept it.'}</span>
          {:else}
            {#if submission.message}
              <span class="submission-detail">{submission.message}</span>
            {/if}
            <span class="submission-warning"
              >Some input may have reached the terminal. Check it before sending again.</span
            >
            <pre class="submission-draft" aria-label="Draft excerpt">{submission.draft}</pre>
          {/if}
        </div>
        {#if submission.status !== 'pending'}
          <div class="submission-actions">
            <button type="button" onclick={() => restore(submission)}>Restore draft</button>
            <button type="button" class="dismiss" onclick={() => dismiss(submission.requestId)}>Dismiss</button>
          </div>
        {/if}
      </article>
    {/each}
    {#if submissions.some((submission) => submission.status !== 'pending')}
      <p>Ctrl+Alt+R restores the newest available draft. Restoring never resends it.</p>
    {/if}
  </section>
{/if}

<style>
.submission-recovery {
  /* Delivery acknowledgements must not resize the pane and trigger a tmux redraw. */
  position: absolute;
  z-index: 5;
  right: var(--dock-inline-end);
  bottom: 100%;
  left: var(--dock-inline-start);
  display: grid;
  gap: 0.35rem;
  max-height: min(20rem, 50dvh);
  margin: 0;
  padding: 0.4rem;
  overflow-y: auto;
  overscroll-behavior: contain;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-control);
  background: var(--color-panel);
}
.submission-recovery article {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.7rem;
  min-width: 0;
  padding: 0.48rem 0.58rem;
  border: 1px solid var(--color-warning-border, var(--color-border));
  border-radius: var(--radius-control);
  background: var(--color-surface-raised);
}
.submission-recovery article.pending {
  border-color: var(--color-border-subtle);
}
.submission-copy {
  display: grid;
  gap: 0.1rem;
  min-width: 0;
}
.submission-copy strong,
.submission-copy span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.submission-copy strong {
  color: var(--color-text);
  font-size: var(--text-caption);
}
.submission-warning {
  white-space: normal;
}
.submission-draft {
  display: -webkit-box;
  max-width: 48rem;
  max-height: 2.8em;
  margin: 0.18rem 0 0;
  overflow: hidden;
  color: var(--color-text);
  font-family: var(--font-mono);
  font-size: var(--text-micro);
  line-height: var(--leading-ui);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
}
.submission-copy span,
.submission-recovery > p {
  color: var(--color-text-secondary);
  font-size: var(--text-micro);
}
.submission-actions {
  display: flex;
  flex: 0 0 auto;
  gap: 0.25rem;
}
.submission-actions button {
  min-height: 1.8rem;
  padding: 0 0.5rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-control);
  background: var(--color-control-background);
  color: var(--color-text);
  font: inherit;
  font-size: var(--text-micro);
  cursor: pointer;
}
.submission-actions button.dismiss {
  border-color: transparent;
  background: transparent;
  color: var(--color-text-secondary);
}
.submission-recovery > p {
  margin: 0;
}
@media (max-width: 42rem) {
  .submission-recovery article {
    align-items: stretch;
    flex-direction: column;
  }
}
</style>
