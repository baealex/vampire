<script lang="ts">
import { DropdownMenu } from 'bits-ui';

let { class: className }: { class?: string } = $props();
</script>

<DropdownMenu.Separator class={className} />
