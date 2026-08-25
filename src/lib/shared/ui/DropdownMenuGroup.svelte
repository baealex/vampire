<script lang="ts">
import type { Snippet } from 'svelte';
import { DropdownMenu } from 'bits-ui';

let { label, children }: { label: string; children: Snippet } = $props();
</script>

<DropdownMenu.Group>
  <DropdownMenu.GroupHeading class="vampire-menu-group-heading">{label}</DropdownMenu.GroupHeading>
  {@render children()}
</DropdownMenu.Group>

<style>
:global(.vampire-menu-group-heading) {
  padding: 0.35rem 0.55rem 0.2rem;
  color: var(--color-text-tertiary);
  font-size: var(--text-micro);
  font-weight: var(--weight-medium);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
</style>
