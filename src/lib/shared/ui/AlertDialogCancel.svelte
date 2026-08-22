<script lang="ts">
import { AlertDialog } from 'bits-ui';
import type { Snippet } from 'svelte';

let {
  class: className,
  disabled = false,
  variant = 'secondary',
  onclick,
  children,
}: {
  class?: string;
  disabled?: boolean;
  variant?: 'secondary' | 'danger-outline';
  onclick?: (event: MouseEvent) => void;
  children?: Snippet;
} = $props();

const cancelClass = $derived(
  ['vampire-dialog-button', `vampire-dialog-button--${variant}`, className ?? ''].filter(Boolean).join(' ')
);
</script>

<AlertDialog.Cancel class={cancelClass} {disabled} {onclick}> {@render children?.()} </AlertDialog.Cancel>
