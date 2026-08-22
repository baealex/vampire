<script lang="ts">
import type { Snippet } from 'svelte';

let {
  label,
  id,
  description,
  error,
  children,
}: {
  label: string;
  id?: string;
  description?: string;
  error?: string;
  children: Snippet;
} = $props();
</script>

<label class="field" for={id}>
  <span class="field__label">{label}</span>
  {@render children()}
  {#if description}
    <span class="field__description">{description}</span>
  {/if}
  {#if error}
    <span class="field__error" role="alert">{error}</span>
  {/if}
</label>

<style>
.field {
  display: grid;
  min-width: 0;
  gap: var(--space-2);
}

.field__label {
  color: var(--color-text-secondary);
  font-size: var(--text-caption);
  font-weight: var(--weight-medium);
  line-height: var(--leading-ui);
}

.field__description {
  color: var(--color-text-tertiary);
  font-size: var(--text-caption);
  line-height: var(--leading-body);
}

.field__error {
  color: var(--color-danger-text);
  font-size: var(--text-caption);
  line-height: var(--leading-ui);
}
</style>
