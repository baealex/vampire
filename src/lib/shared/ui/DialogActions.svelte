<script lang="ts">
import type { Snippet } from 'svelte';

let {
  class: className,
  split = false,
  children,
}: {
  class?: string;
  split?: boolean;
  children?: Snippet;
} = $props();

const actionsClass = $derived(['actions', split ? 'actions--split' : '', className ?? ''].filter(Boolean).join(' '));
</script>

<div class={actionsClass}>
  {@render children?.()}
</div>

<style>
.actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.actions--split {
  justify-content: flex-start;
}
</style>
