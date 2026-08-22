<script lang="ts">
import { AlertDialog } from 'bits-ui';
import type { Snippet } from 'svelte';

let { class: className, children }: { class?: string; children?: Snippet } = $props();
</script>

<AlertDialog.Description class={className}> {@render children?.()} </AlertDialog.Description>
