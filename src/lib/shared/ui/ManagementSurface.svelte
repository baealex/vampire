<script lang="ts">
import ArrowLeft from '@lucide/svelte/icons/arrow-left';
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
let viewportStyle = $state('');

onMount(() => {
  if (focusOnMount) void tick().then(() => titleElement?.focus());

  const updateViewport = () => {
    if (window.matchMedia?.('(min-width: 64rem)').matches) {
      viewportStyle = '';
      return;
    }
    const viewport = window.visualViewport;
    const height = Math.round(viewport?.height ?? window.innerHeight);
    const top = Math.round(viewport?.offsetTop ?? 0);
    viewportStyle = `--management-viewport-height: ${height}px; --management-viewport-top: ${top}px;`;
  };

  updateViewport();
  window.addEventListener('resize', updateViewport);
  window.visualViewport?.addEventListener('resize', updateViewport);
  window.visualViewport?.addEventListener('scroll', updateViewport);

  return () => {
    window.removeEventListener('resize', updateViewport);
    window.visualViewport?.removeEventListener('resize', updateViewport);
    window.visualViewport?.removeEventListener('scroll', updateViewport);
  };
});
</script>

<section class="management-surface" style={viewportStyle} aria-labelledby={titleId}>
  <header class="management-header">
    <div class="management-header-inner">
      <button
        type="button"
        class="management-back"
        onclick={back ?? close}
        disabled={busy}
        aria-label={back ? backLabel : closeLabel}
      >
        <ArrowLeft size={19} strokeWidth={1.8} aria-hidden="true" />
      </button>
      <div class="management-heading">
        {#if eyebrow}
          <p>{eyebrow}</p>
        {/if}
        <h1 bind:this={titleElement} id={titleId} tabindex="-1">{title}</h1>
      </div>
    </div>
  </header>
  <div class="management-body">
    <div class="management-content">
      {@render children()}
      {#if footer && showFooter}
        <footer>{@render footer()}</footer>
      {/if}
    </div>
  </div>
</section>

<style>
.management-surface {
  min-width: 0;
  min-height: 0;
  height: 100%;
  overflow: auto;
  overscroll-behavior: contain;
  background: var(--color-surface);
  color: var(--color-text);
}
.management-header {
  position: sticky;
  z-index: 2;
  top: 0;
  border-bottom: 1px solid var(--color-border);
  background: color-mix(in srgb, var(--color-surface) 94%, transparent);
  backdrop-filter: blur(12px);
}
.management-header-inner {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  width: min(100%, 70rem);
  margin: 0 auto;
  gap: 0.7rem;
  min-height: 4.5rem;
  padding: max(0.8rem, env(safe-area-inset-top)) max(1rem, env(safe-area-inset-right)) 0.8rem
    max(1rem, env(safe-area-inset-left));
  box-sizing: border-box;
}
.management-heading {
  display: grid;
  min-width: 0;
  gap: 0.05rem;
}
p,
h1 {
  overflow: hidden;
  margin: 0;
  text-overflow: ellipsis;
  white-space: nowrap;
}
h1:focus {
  outline: none;
}
p {
  color: var(--color-text-tertiary);
  font-size: var(--text-caption);
  line-height: var(--leading-ui);
}
h1 {
  font-size: clamp(var(--text-title), 2vw, 1.35rem);
  font-weight: var(--weight-strong);
  line-height: var(--leading-tight);
}
.management-back {
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
.management-back:disabled {
  cursor: wait;
  opacity: 0.55;
}
.management-body {
  min-width: 0;
  min-height: 0;
  padding: 1rem 0 max(2rem, env(safe-area-inset-bottom));
}
.management-content {
  display: grid;
  width: min(100%, 70rem);
  margin: 0 auto;
  padding-right: calc(max(1rem, env(safe-area-inset-right)) + var(--control-height-md) + 0.7rem);
  padding-left: calc(max(1rem, env(safe-area-inset-left)) + var(--control-height-md) + 0.7rem);
  box-sizing: border-box;
  gap: clamp(1.5rem, 3vw, 2.5rem);
}
footer {
  padding-top: 1rem;
  border-top: 1px solid var(--color-border);
}
@media (hover: hover) {
  .management-back:not(:disabled):hover {
    background: var(--color-surface-raised);
    color: var(--color-text);
  }
}
@media (max-width: 42rem) {
  .management-content {
    padding-right: max(1rem, env(safe-area-inset-right));
    padding-left: max(1rem, env(safe-area-inset-left));
  }
}
@media (max-width: 63.999rem) {
  .management-surface {
    position: fixed;
    z-index: 30;
    top: var(--management-viewport-top, 0);
    left: 0;
    width: 100%;
    height: var(--management-viewport-height, 100dvh);
    min-height: 0;
  }
}
@media (max-width: 32rem) {
  .management-header-inner {
    min-height: 4.25rem;
    padding-right: max(0.8rem, env(safe-area-inset-right));
    padding-left: max(0.8rem, env(safe-area-inset-left));
  }
  .management-body {
    padding-top: 0.8rem;
  }
  .management-content {
    padding-right: max(0.8rem, env(safe-area-inset-right));
    padding-left: max(0.8rem, env(safe-area-inset-left));
  }
}
</style>
