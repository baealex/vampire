<script lang="ts">
	import { DropdownMenu } from 'bits-ui';
	import type { Snippet } from 'svelte';

	let {
		open = $bindable(false),
		onOpenChange = () => undefined,
		triggerLabel,
		triggerTitle,
		trigger,
		children
	}: {
		open?: boolean;
		onOpenChange?: (open: boolean) => void;
		triggerLabel: string;
		triggerTitle?: string;
		trigger?: Snippet;
		children?: Snippet;
	} = $props();

	function handleOpenChange(nextOpen: boolean) {
		open = nextOpen;
		onOpenChange(nextOpen);
	}
</script>

<DropdownMenu.Root bind:open onOpenChange={handleOpenChange}>
	<DropdownMenu.Trigger class="vampire-menu-trigger" aria-label={triggerLabel} title={triggerTitle}>
		{@render trigger?.()}
	</DropdownMenu.Trigger>
	<DropdownMenu.Portal>
		<DropdownMenu.Content data-menu-content class="vampire-menu-content" sideOffset={6} align="start">
			{@render children?.()}
		</DropdownMenu.Content>
	</DropdownMenu.Portal>
</DropdownMenu.Root>
