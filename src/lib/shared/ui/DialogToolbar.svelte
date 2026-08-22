<script lang="ts">
import type { Snippet } from 'svelte';

let { children }: { children?: Snippet } = $props();
</script>

<div class="toolbar">
  {@render children?.()}
</div>

<style>
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-width: 0;
  min-height: 2.75rem;
  gap: 0.65rem;
  padding-bottom: 0.7rem;
  border-bottom: 1px solid var(--color-border-subtle);
  color: var(--color-text-tertiary);
  font-size: var(--text-caption);
}
</style>
