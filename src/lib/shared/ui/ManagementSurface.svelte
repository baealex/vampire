<script lang="ts">
import ArrowLeft from '@lucide/svelte/icons/arrow-left';
import X from '@lucide/svelte/icons/x';
import { onMount, tick, type Snippet } from 'svelte';

let {
  title,
  titleId,
  eyebrow,
  back,
  backLabel = 'Back',
  close,
  closeLabel = 'Close',
  busy = false,
  focusOnMount = true,
  showFooter = true,
  children,
  footer,
}: {
  title: string;
  titleId: string;
  eyebrow?: string;
  back?: () => void;
  backLabel?: string;
  close: () => void;
  closeLabel?: string;
  busy?: boolean;
  focusOnMount?: boolean;
  showFooter?: boolean;
  children: Snippet;
  footer?: Snippet;
} = $props();
let titleElement = $state<HTMLHeadingElement>();

onMount(() => {
  if (!focusOnMount) return;
  void tick().then(() => titleElement?.focus());
});
</script>

<section class="management-surface" aria-labelledby={titleId}>
  <header>
    <div class="management-heading">
      {#if back}
        <button type="button" class="management-icon-button" onclick={back} disabled={busy} aria-label={backLabel}>
          <ArrowLeft size={19} strokeWidth={1.8} aria-hidden="true" />
        </button>
      {/if}
      <div>
        {#if eyebrow}
          <p>{eyebrow}</p>
        {/if}
        <h1 bind:this={titleElement} id={titleId} tabindex="-1">{title}</h1>
      </div>
    </div>
    <button type="button" class="management-icon-button" onclick={close} disabled={busy} aria-label={closeLabel}>
      <X size={19} strokeWidth={1.8} aria-hidden="true" />
    </button>
  </header>
  <div class="management-body">{@render children()}</div>
  {#if footer && showFooter}
    <footer>{@render footer()}</footer>
  {/if}
</section>

<style>
.management-surface {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  min-width: 0;
  min-height: 0;
  height: 100%;
  overflow: hidden;
  background: var(--color-surface);
  color: var(--color-text);
}
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  min-height: 4.5rem;
  padding: max(0.8rem, env(safe-area-inset-top)) max(1rem, env(safe-area-inset-right)) 0.8rem
    max(1rem, env(safe-area-inset-left));
  border-bottom: 1px solid var(--color-border);
  background: var(--color-panel);
}
.management-heading {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 0.6rem;
}
.management-heading > div {
  min-width: 0;
}
p,
h1 {
  overflow: hidden;
  margin: 0;
  text-overflow: ellipsis;
  white-space: nowrap;
}
p {
  color: var(--color-text-tertiary);
  font-size: var(--text-caption);
  line-height: var(--leading-ui);
}
h1 {
  font-size: var(--text-title);
  font-weight: var(--weight-strong);
  line-height: var(--leading-tight);
}
.management-icon-button {
  display: grid;
  flex: 0 0 var(--control-height-md);
  place-items: center;
  width: var(--control-height-md);
  height: var(--control-height-md);
  padding: 0;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
}
.management-icon-button:disabled {
  cursor: wait;
  opacity: 0.55;
}
.management-body {
  min-width: 0;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  padding: clamp(1rem, 3vw, 2rem);
}
footer {
  padding: 0.8rem max(1rem, env(safe-area-inset-right)) max(0.8rem, env(safe-area-inset-bottom))
    max(1rem, env(safe-area-inset-left));
  border-top: 1px solid var(--color-border);
  background: var(--color-panel);
}
@media (hover: hover) {
  .management-icon-button:not(:disabled):hover {
    background: var(--color-surface-raised);
    color: var(--color-text);
  }
}
@media (min-width: 64rem) {
  .management-body {
    padding-inline: max(2rem, calc((100% - 64rem) / 2));
  }
}
</style>
