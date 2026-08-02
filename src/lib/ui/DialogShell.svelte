<script lang="ts">
	import { Dialog } from 'bits-ui';
	import X from '@lucide/svelte/icons/x';
	import type { Snippet } from 'svelte';

	let {
		eyebrow,
		title,
		close,
		closeDisabled = false,
		variant = 'default',
		children
	}: {
		eyebrow?: string;
		title: string;
		close: () => void;
		closeDisabled?: boolean;
		variant?: 'default' | 'inspect';
		children?: Snippet;
	} = $props();

	function handleOpenChange(open: boolean) {
		if (!open && !closeDisabled) close();
	}
</script>

<Dialog.Root open={true} onOpenChange={handleOpenChange}>
	<Dialog.Portal>
		<Dialog.Overlay class="vampire-dialog-overlay" />
		<Dialog.Content
			data-vampire-overlay
			class={`vampire-dialog-content${variant === 'inspect' ? ' vampire-dialog-content--inspect' : ''}`}
			escapeKeydownBehavior={closeDisabled ? 'ignore' : 'close'}
			interactOutsideBehavior={closeDisabled ? 'ignore' : 'close'}
		>
			<header class="vampire-dialog-header">
				<div>
					{#if eyebrow}<p class="vampire-dialog-eyebrow">{eyebrow}</p>{/if}
					<Dialog.Title class="vampire-dialog-title">{title}</Dialog.Title>
				</div>
				<Dialog.Close class="vampire-dialog-close" disabled={closeDisabled} aria-label="Close">
					<X size={18} strokeWidth={1.8} aria-hidden="true" />
				</Dialog.Close>
			</header>
			<div class="vampire-dialog-body">
				{@render children?.()}
			</div>
		</Dialog.Content>
	</Dialog.Portal>
</Dialog.Root>
