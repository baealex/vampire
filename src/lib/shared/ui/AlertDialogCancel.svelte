<script lang="ts">
import { AlertDialog } from 'bits-ui';
import type { Snippet } from 'svelte';

let {
  class: className,
  disabled = false,
  onclick,
  children,
}: {
  class?: string;
  disabled?: boolean;
  onclick?: (event: MouseEvent) => void;
  children?: Snippet;
} = $props();
</script>

<AlertDialog.Cancel class={className} {disabled} {onclick}> {@render children?.()} </AlertDialog.Cancel>
