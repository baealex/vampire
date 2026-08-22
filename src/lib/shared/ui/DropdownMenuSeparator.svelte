<script lang="ts">
import { DropdownMenu } from 'bits-ui';

let { class: className }: { class?: string } = $props();

const separatorClass = $derived(['vampire-menu-separator', className ?? ''].filter(Boolean).join(' '));
</script>

<DropdownMenu.Separator class={separatorClass} />

<style>
:global(.vampire-menu-separator) {
  height: 1px;
  margin: 0.2rem 0;
  background: var(--color-divider-subtle);
}
</style>
