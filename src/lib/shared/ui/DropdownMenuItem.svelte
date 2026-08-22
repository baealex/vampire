<script lang="ts">
import { DropdownMenu } from 'bits-ui';
import type { Snippet } from 'svelte';

let {
  class: className,
  disabled = false,
  ariaLabel,
  onSelect,
  children,
}: {
  class?: string;
  disabled?: boolean;
  ariaLabel?: string;
  onSelect?: (event: Event) => void;
  children?: Snippet;
} = $props();
</script>

<DropdownMenu.Item class={className} {disabled} aria-label={ariaLabel} {onSelect}>
  {@render children?.()}
</DropdownMenu.Item>
