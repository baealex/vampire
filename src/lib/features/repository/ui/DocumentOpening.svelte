<script lang="ts">
let {
  kind,
  path,
}: {
  kind: 'commit' | 'diff' | 'file' | 'image';
  path: string;
} = $props();

const fileName = $derived(path.split('/').pop() || path);
function openingStatus(value: typeof kind): string {
  if (value === 'commit') return 'Loading commit';
  if (value === 'diff') return 'Loading changes';
  if (value === 'image') return 'Loading image';
  return 'Loading file';
}

const status = $derived(openingStatus(kind));
</script>

<div class="document-opening" role="status" aria-label={`${status}: ${fileName}`}>
  <span class="document-opening__spinner" aria-hidden="true"></span>
  <div class="document-opening__message">
    <span>{status}</span>
    <code title={path}>{fileName}</code>
  </div>
</div>

<style>
.document-opening {
  display: grid;
  min-width: 0;
  min-height: 100%;
  place-content: center;
  place-items: center;
  gap: 0.8rem;
  padding: 1.5rem;
  overflow: hidden;
  background: var(--color-code-background);
  color: var(--color-text-tertiary);
}

.document-opening__spinner {
  width: 1.15rem;
  height: 1.15rem;
  border: 2px solid var(--color-border);
  border-top-color: var(--color-accent);
  border-radius: 50%;
  animation: document-spinner 800ms linear infinite;
}

.document-opening__message {
  display: grid;
  max-width: min(24rem, 78vw);
  justify-items: center;
  gap: 0.25rem;
  font-family: var(--font-mono);
  font-size: var(--text-caption);
}

.document-opening__message > span {
  color: var(--color-text-secondary);
  font-weight: var(--weight-medium);
}

.document-opening__message > code {
  max-width: 100%;
  overflow: hidden;
  color: var(--color-text-disabled);
  font: inherit;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@keyframes document-spinner {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .document-opening__spinner {
    animation: none;
  }
}
</style>
