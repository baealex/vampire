<script lang="ts">
import RefreshCw from '@lucide/svelte/icons/refresh-cw';
import type { TmuxStatus } from '~/lib/shared/contracts/tmux-status';

let { status }: { status: TmuxStatus } = $props();
</script>

<section class="setup-screen" aria-labelledby="tmux-setup-title">
  <div class="setup-content">
    <div class="setup-intro">
      <p class="eyebrow">Action required</p>
      <h1 id="tmux-setup-title">Install tmux to continue</h1>
      <p class="lede">Vampire uses tmux to keep workspace shells running on this server.</p>
    </div>

    <div class="install-panel">
      <header class="install-header">
        <div>
          <span>Run on the Vampire server</span>
          <strong>{status.install.platform}</strong>
        </div>
      </header>

      <div class="terminal" aria-label={`${status.install.platform} tmux installation commands`}>
        <div class="terminal-bar" aria-hidden="true">
          <span></span><span></span><span></span>
        </div>
        <div class="terminal-body">
          {#each status.install.commands as command}
            <div class="command"><span aria-hidden="true">$</span><code>{command}</code></div>
          {/each}
        </div>
      </div>

      <p class="install-note">{status.install.note}</p>
      <button class="check-button" type="button" onclick={() => location.reload()}>
        <RefreshCw size={16} strokeWidth={1.9} aria-hidden="true" />
        Check installation
      </button>
    </div>
  </div>
</section>

<style>
.setup-screen {
  display: grid;
  min-height: 100dvh;
  place-items: center;
  overflow: hidden;
  padding: max(1rem, env(safe-area-inset-top)) max(1rem, env(safe-area-inset-right))
    max(1rem, env(safe-area-inset-bottom)) max(1rem, env(safe-area-inset-left));
  background: radial-gradient(circle at 50% 42%, var(--color-accent-soft) 0, transparent 34rem), var(--color-canvas);
  color: var(--color-text);
}
.setup-content {
  display: grid;
  grid-template-columns: minmax(0, 0.9fr) minmax(22rem, 1.1fr);
  align-items: center;
  gap: clamp(3rem, 8vw, 7rem);
  width: min(100%, 60rem);
}
.setup-intro {
  display: flex;
  min-width: 0;
  flex-direction: column;
  align-items: flex-start;
}
.eyebrow {
  margin: 0 0 0.55rem;
  color: var(--color-accent-soft-text);
  font-size: var(--text-caption);
  font-weight: var(--weight-strong);
  letter-spacing: 0.08em;
  line-height: var(--leading-ui);
  text-transform: uppercase;
}
h1 {
  max-width: 12ch;
  margin: 0;
  font-size: clamp(2rem, 5vw, 3.1rem);
  font-weight: var(--weight-strong);
  letter-spacing: -0.045em;
  line-height: 1.02;
}
.lede {
  max-width: 34rem;
  margin: 1rem 0 0;
  color: var(--color-text-secondary);
  font-size: var(--text-title);
  line-height: var(--leading-body);
}
.install-panel {
  min-width: 0;
  padding: clamp(1.15rem, 3vw, 1.5rem);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-surface);
  box-shadow: var(--shadow-dialog);
}
.install-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1rem;
}
.install-header div {
  display: grid;
  gap: 0.2rem;
}
.install-header span {
  color: var(--color-text-tertiary);
  font-size: var(--text-caption);
}
.install-header strong {
  font-size: var(--text-title);
  font-weight: var(--weight-strong);
}
.terminal {
  overflow: hidden;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-md);
  background: var(--color-code-background);
  color: var(--color-code-text);
}
.terminal-bar {
  display: flex;
  align-items: center;
  gap: 0.32rem;
  height: 2rem;
  padding: 0 0.75rem;
  border-bottom: 1px solid var(--color-border-subtle);
  background: var(--color-surface-sunken);
}
.terminal-bar span {
  width: 0.42rem;
  height: 0.42rem;
  border-radius: 50%;
  background: var(--color-border-strong);
}
.terminal-body {
  display: grid;
  gap: 0.75rem;
  padding: 1rem;
}
.command {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: start;
  gap: 0.65rem;
  font-family: var(--font-mono);
  font-size: var(--text-label);
  line-height: 1.55;
}
.command > span {
  color: var(--color-accent);
  font-weight: var(--weight-strong);
}
.command code {
  min-width: 0;
  overflow-wrap: anywhere;
  color: inherit;
  font: inherit;
}
.install-note {
  margin: 0.85rem 0 1.1rem;
  color: var(--color-text-tertiary);
  font-size: var(--text-caption);
  line-height: var(--leading-body);
}
.check-button {
  display: inline-flex;
  width: 100%;
  min-height: var(--control-height-lg);
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  border: 0;
  border-radius: var(--radius-sm);
  background: var(--color-accent);
  color: var(--color-accent-ink);
  font: inherit;
  font-size: var(--text-label);
  font-weight: var(--weight-strong);
  cursor: pointer;
}
@media (hover: hover) {
  .check-button:hover {
    background: var(--color-accent-hover);
  }
}
.check-button:focus-visible {
  outline: none;
  box-shadow: var(--shadow-accent-focus);
}

@media (max-width: 48rem) {
  .setup-screen {
    overflow: auto;
  }
  .setup-content {
    grid-template-columns: minmax(0, 1fr);
    gap: 2rem;
    width: min(100%, 34rem);
    padding: 1.5rem 0;
  }
  h1 {
    max-width: none;
  }
  .lede {
    font-size: var(--text-body);
  }
}

@media (max-width: 28rem) {
  .setup-content {
    padding: 1rem 0;
  }
}
</style>
