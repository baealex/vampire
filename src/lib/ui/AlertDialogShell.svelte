<script lang="ts">
	import { AlertDialog } from 'bits-ui';
	import X from '@lucide/svelte/icons/x';
	import type { Snippet } from 'svelte';

	let {
		eyebrow,
		title,
		close,
		closeDisabled = false,
		children
	}: {
		eyebrow?: string;
		title: string;
		close: () => void;
		closeDisabled?: boolean;
		children?: Snippet;
	} = $props();

	function handleOpenChange(open: boolean) {
		if (!open && !closeDisabled) close();
	}
</script>

<AlertDialog.Root open={true} onOpenChange={handleOpenChange}>
	<AlertDialog.Portal>
		<AlertDialog.Overlay class="vampire-dialog-overlay vampire-alert-dialog-overlay" />
		<AlertDialog.Content data-vampire-overlay class="vampire-dialog-content vampire-alert-dialog-content" escapeKeydownBehavior={closeDisabled ? 'ignore' : 'close'}>
			<header class="vampire-dialog-header">
				<div>
					{#if eyebrow}<p class="vampire-dialog-eyebrow">{eyebrow}</p>{/if}
					<AlertDialog.Title class="vampire-dialog-title">{title}</AlertDialog.Title>
				</div>
				<AlertDialog.Cancel class="vampire-dialog-close" disabled={closeDisabled} aria-label="Close">
					<X size={18} strokeWidth={1.8} aria-hidden="true" />
				</AlertDialog.Cancel>
			</header>
			<div class="vampire-dialog-body">
				{@render children?.()}
			</div>
		</AlertDialog.Content>
	</AlertDialog.Portal>
</AlertDialog.Root>
