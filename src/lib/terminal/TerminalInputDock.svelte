<script lang="ts">
	import Send from '@lucide/svelte/icons/send';
	import ImagePlus from '@lucide/svelte/icons/image-plus';

	let {
		connected,
		send,
		onComposerFocus,
		onImageSelected,
		fontSize,
		minimumFontSize,
		maximumFontSize,
		decreaseFontSize,
		increaseFontSize
	}: {
		connected: boolean;
		send: (data: string) => void;
		onComposerFocus: () => void;
		onImageSelected: (image: File) => void;
		fontSize: number;
		minimumFontSize: number;
		maximumFontSize: number;
		decreaseFontSize: () => void;
		increaseFontSize: () => void;
	} = $props();

	let composerElement: HTMLTextAreaElement;
	let imageInputElement: HTMLInputElement;
	let composerMessage = $state('');

	function keepComposerFocused(event: PointerEvent) {
		event.preventDefault();
	}

	function focusComposer() {
		onComposerFocus();
		requestAnimationFrame(() => composerElement?.focus());
	}

	function sendControl(data: string) {
		send(data);
		focusComposer();
	}

	function sendComposerMessage() {
		if (!connected || !composerMessage.trim()) return;
		send(`${composerMessage}\r`);
		composerMessage = '';
		requestAnimationFrame(() => {
			resizeComposer();
			composerElement?.focus();
		});
	}

	function resizeComposer() {
		if (!composerElement) return;
		composerElement.style.height = 'auto';
		composerElement.style.height = `${Math.min(composerElement.scrollHeight, 128)}px`;
	}

	function handleComposerKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			sendComposerMessage();
		}
	}

	function handleImageSelection(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const image = input.files?.[0];
		if (image) onImageSelected(image);
		input.value = '';
	}
</script>

<div class="input-dock">
	<div class="touch-toolbar" aria-label="Terminal controls">
		<button type="button" disabled={!connected} onpointerdown={keepComposerFocused} onclick={() => sendControl('\u001b')}>Esc</button>
		<button type="button" class="wide-key" disabled={!connected} onpointerdown={keepComposerFocused} onclick={() => sendControl('\u0003')}>Ctrl+C</button>
		<button type="button" disabled={!connected} onpointerdown={keepComposerFocused} onclick={() => sendControl('\t')}>Tab</button>
		<button type="button" class="wide-key" disabled={!connected} onpointerdown={keepComposerFocused} onclick={() => sendControl('\r')}>Enter</button>
		<button type="button" disabled={!connected} aria-label="Arrow up" onpointerdown={keepComposerFocused} onclick={() => sendControl('\u001b[A')}>↑</button>
		<button type="button" disabled={!connected} aria-label="Arrow down" onpointerdown={keepComposerFocused} onclick={() => sendControl('\u001b[B')}>↓</button>
		<button type="button" disabled={!connected} aria-label="Arrow left" onpointerdown={keepComposerFocused} onclick={() => sendControl('\u001b[D')}>←</button>
		<button type="button" disabled={!connected} aria-label="Arrow right" onpointerdown={keepComposerFocused} onclick={() => sendControl('\u001b[C')}>→</button>
		<span class="toolbar-divider" aria-hidden="true"></span>
		<button
			type="button"
			aria-label="Decrease terminal text size"
			title="Decrease text size"
			disabled={fontSize <= minimumFontSize}
			onpointerdown={keepComposerFocused}
			onclick={decreaseFontSize}
		>A−</button>
		<button
			type="button"
			aria-label="Increase terminal text size"
			title="Increase text size"
			disabled={fontSize >= maximumFontSize}
			onpointerdown={keepComposerFocused}
			onclick={increaseFontSize}
		>A+</button>
	</div>
	<div class="composer">
		<label class="visually-hidden" for="shell-message">Send text to the shell</label>
		<input
			class="visually-hidden"
			bind:this={imageInputElement}
			type="file"
			accept="image/avif,image/gif,image/jpeg,image/png,image/webp"
			onchange={handleImageSelection}
			tabindex="-1"
		/>
		<textarea
			id="shell-message"
			bind:this={composerElement}
			bind:value={composerMessage}
			oninput={resizeComposer}
			onkeydown={handleComposerKeydown}
			onfocus={onComposerFocus}
			rows="1"
			placeholder="Send to shell…"
			autocapitalize="off"
			autocomplete="off"
			spellcheck="false"
			disabled={!connected}
		></textarea>
		<button
			class="image-button"
			type="button"
			onclick={() => imageInputElement?.click()}
			disabled={!connected}
			aria-label="Send an image to the shell"
			title="Send an image"
		>
			<ImagePlus size={18} strokeWidth={1.8} aria-hidden="true" />
		</button>
		<button
			class="send-button"
			type="button"
			onpointerdown={keepComposerFocused}
			onclick={sendComposerMessage}
			disabled={!connected || !composerMessage.trim()}
			aria-label="Send to shell"
			title="Send text and press Enter"
		>
			<Send size={19} strokeWidth={1.8} aria-hidden="true" />
		</button>
	</div>
</div>

<style>
	.input-dock { min-width: 0; border-top: 1px solid #2d292a; background: #131112; box-shadow: 0 -0.5rem 1.5rem rgb(0 0 0 / 0.16); }
	.touch-toolbar { display: flex; gap: 0.3rem; min-width: 0; overflow-x: auto; padding: 0.45rem max(0.45rem, env(safe-area-inset-right)) 0.25rem max(0.45rem, env(safe-area-inset-left)); scrollbar-width: none; }
	.touch-toolbar::-webkit-scrollbar { display: none; }
	.touch-toolbar button { flex: 0 0 2.45rem; min-width: 2.45rem; min-height: 2.35rem; padding: 0 0.2rem; border: 1px solid #393334; border-radius: 0.5rem; background: #1c191a; color: #eee8e9; font: inherit; font-size: var(--text-caption); font-weight: var(--weight-medium); cursor: pointer; touch-action: manipulation; }
	.touch-toolbar button:hover:not(:disabled) { background: #282324; }
	.touch-toolbar button:disabled { color: #5e5658; cursor: default; }
	.touch-toolbar .wide-key { flex-basis: 3.4rem; min-width: 3.4rem; }
	.toolbar-divider { flex: 0 0 1px; align-self: stretch; margin: 0 0.15rem; background: #393334; }
	.composer { display: grid; grid-template-columns: minmax(0, 1fr) 2.5rem 2.5rem; align-items: end; gap: 0.2rem; min-width: 0; margin: 0.35rem max(0.55rem, env(safe-area-inset-right)) max(0.5rem, env(safe-area-inset-bottom)) max(0.55rem, env(safe-area-inset-left)); padding: 0.22rem; border: 1px solid #40393b; border-radius: 0.78rem; background: #1c191a; }
	.composer:focus-within { border-color: #a54a53; box-shadow: 0 0 0 0.2rem rgb(228 91 103 / 0.12); }
	.visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
	.composer textarea { width: 100%; min-width: 0; min-height: 2.5rem; max-height: 8rem; padding: 0.58rem 0.62rem; overflow-y: auto; resize: none; border: 0; border-radius: 0.55rem; outline: none; background: transparent; color: #eee8e9; font: inherit; font-size: 1rem; line-height: var(--leading-ui); }
	.composer textarea::placeholder { color: #756d6f; }
	.composer button { display: grid; place-items: center; width: 2.5rem; height: 2.5rem; padding: 0; border: 0; border-radius: 0.58rem; cursor: pointer; touch-action: manipulation; }
	.image-button { background: transparent; color: #aaa2a4; }
	.image-button:hover:not(:disabled) { background: #2b2627; color: #f3edef; }
	.send-button { background: #e45b67; color: #19090b; }
	.send-button:hover:not(:disabled) { background: #ef707b; }
	.composer button:disabled { background: transparent; color: #625b5d; cursor: default; }

	@media (min-width: 64rem) {
		.touch-toolbar { display: none; }
		.composer { margin: 0.6rem 0.75rem 0.7rem; }
		.composer textarea { font-size: var(--text-body); }
	}
</style>
