<script lang="ts">
import { AlertDialog } from 'bits-ui';
import type { Snippet } from 'svelte';

let {
  class: className,
  disabled = false,
  variant = 'primary',
  onclick,
  children,
}: {
  class?: string;
  disabled?: boolean;
  variant?: 'primary' | 'danger' | 'danger-outline';
  onclick?: (event: MouseEvent) => void;
  children?: Snippet;
} = $props();

const actionClass = $derived(
  ['vampire-dialog-button', `vampire-dialog-button--${variant}`, className ?? ''].filter(Boolean).join(' ')
);
</script>

<AlertDialog.Action class={actionClass} {disabled} {onclick}> {@render children?.()} </AlertDialog.Action>
