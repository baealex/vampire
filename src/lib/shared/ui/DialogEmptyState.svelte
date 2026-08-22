<script lang="ts">
import type { Snippet } from 'svelte';

let {
  class: className,
  role,
  as = 'p',
  children,
}: {
  class?: string;
  role?: string;
  as?: 'p' | 'div';
  children?: Snippet;
} = $props();

const emptyClass = $derived(['empty-state', className ?? ''].filter(Boolean).join(' '));
</script>

<svelte:element this={as} class={emptyClass} {role}> {@render children?.()} </svelte:element>

<style>
.empty-state {
  display: grid;
  place-items: center;
  min-height: 5rem;
  margin: 0;
  padding: 1rem;
  color: var(--color-text-tertiary);
  font-size: var(--text-caption);
  text-align: center;
}
</style>
