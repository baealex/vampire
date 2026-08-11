<script lang="ts">
	import { Dialog } from 'bits-ui';
	import X from '@lucide/svelte/icons/x';
	import { onMount, type Snippet } from 'svelte';

	let {
		eyebrow,
		title,
		close,
		closeDisabled = false,
		variant = 'default',
		contentId,
		closeLabel = 'Close',
		onCloseAutoFocus,
		children
	}: {
		eyebrow?: string;
		title: string;
		close: () => void;
		closeDisabled?: boolean;
		variant?: 'default' | 'inspect' | 'sheet';
		contentId?: string;
		closeLabel?: string;
		onCloseAutoFocus?: (event: Event) => void;
		children?: Snippet;
	} = $props();
	let sheetStyle = $state('');

	onMount(() => {
		if (variant !== 'sheet') return;
		const updateSheetViewport = () => {
			const viewport = window.visualViewport;
			const viewportHeight = Math.round(viewport?.height ?? window.innerHeight);
			const viewportTop = Math.round(viewport?.offsetTop ?? 0);
			const rootFontSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
			const sheetHeight = Math.max(0, Math.min(34 * rootFontSize, viewportHeight - 8));
			const sheetTop = Math.round(viewportTop + viewportHeight - sheetHeight);
			sheetStyle = `--vampire-sheet-top: ${sheetTop}px; --vampire-sheet-height: ${Math.round(sheetHeight)}px; --vampire-sheet-bottom: auto;`;
		};

		updateSheetViewport();
		window.addEventListener('resize', updateSheetViewport);
		window.visualViewport?.addEventListener('resize', updateSheetViewport);
		window.visualViewport?.addEventListener('scroll', updateSheetViewport);
		return () => {
			window.removeEventListener('resize', updateSheetViewport);
			window.visualViewport?.removeEventListener('resize', updateSheetViewport);
			window.visualViewport?.removeEventListener('scroll', updateSheetViewport);
		};
	});

	function handleOpenChange(open: boolean) {
		if (!open && !closeDisabled) close();
	}
</script>

<Dialog.Root open={true} onOpenChange={handleOpenChange}>
	<Dialog.Portal>
		<Dialog.Overlay class="vampire-dialog-overlay" />
		<Dialog.Content
			id={contentId}
			data-vampire-overlay
			class={`vampire-dialog-content${variant === 'inspect' ? ' vampire-dialog-content--inspect' : variant === 'sheet' ? ' vampire-dialog-content--sheet' : ''}`}
			style={variant === 'sheet' ? sheetStyle : undefined}
			{onCloseAutoFocus}
			escapeKeydownBehavior={closeDisabled ? 'ignore' : 'close'}
			interactOutsideBehavior={closeDisabled ? 'ignore' : 'close'}
		>
			<header class="vampire-dialog-header">
				<div>
					{#if eyebrow}<p class="vampire-dialog-eyebrow">{eyebrow}</p>{/if}
					<Dialog.Title class="vampire-dialog-title">{title}</Dialog.Title>
				</div>
				<Dialog.Close class="vampire-dialog-close" disabled={closeDisabled} aria-label={closeLabel}>
					<X size={18} strokeWidth={1.8} aria-hidden="true" />
				</Dialog.Close>
			</header>
			<div class="vampire-dialog-body">
				{@render children?.()}
			</div>
		</Dialog.Content>
	</Dialog.Portal>
</Dialog.Root>
