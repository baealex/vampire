<script lang="ts">
import Activity from '@lucide/svelte/icons/activity';
import GitBranch from '@lucide/svelte/icons/git-branch';
import ListTree from '@lucide/svelte/icons/list-tree';
import PanelLeft from '@lucide/svelte/icons/panel-left';
import StickyNote from '@lucide/svelte/icons/sticky-note';
import Button from '~/lib/shared/ui/Button.svelte';

let {
  projectName,
  cwd,
  isWorktree,
  branch,
  hasNote,
  noteOpen,
  statusLabel,
  showTools = true,
  close,
  repositoryOpen,
  isGitRepository,
  workspaceAvailable,
  changeCount,
  worktreeCount,
  backgroundOpen,
  backgroundCount,
  backgroundPanelId,
  backgroundTriggerId,
  toggleRepository,
  toggleNote,
  toggleBackground,
}: {
  projectName: string;
  cwd: string;
  isWorktree: boolean;
  branch?: string;
  hasNote: boolean;
  noteOpen: boolean;
  statusLabel?: string;
  showTools?: boolean;
  close: () => void;
  repositoryOpen: boolean;
  isGitRepository?: boolean;
  workspaceAvailable: boolean;
  changeCount: number;
  worktreeCount: number;
  backgroundOpen: boolean;
  backgroundCount: number;
  backgroundPanelId: string;
  backgroundTriggerId: string;
  toggleRepository: () => void;
  toggleNote: () => void;
  toggleBackground: () => void;
} = $props();
</script>

<header class="terminal-header" class:terminal-header-no-tools={!showTools}>
  <Button class="back-button" variant="icon" onclick={close} ariaLabel="Open workspaces">
    <PanelLeft size={18} strokeWidth={1.8} aria-hidden="true" />
  </Button>
  <div class="terminal-identity">
    <div class="terminal-identity-title">
      <strong>{projectName}</strong>
      {#if branch || isWorktree}
        <span
          class="branch-label"
          title={`${branch ?? 'Git worktree'}${worktreeCount > 1 ? ` · ${worktreeCount} worktrees` : ''}`}
        >
          <GitBranch size={11} strokeWidth={1.9} aria-hidden="true" />
          <span>{branch ?? 'Worktree'}</span>
        </span>
      {/if}
      {#if !workspaceAvailable}
        <span class="working-copy-missing" title="The working directory was removed outside Vampire"
          >Working copy missing</span
        >
      {/if}
      {#if statusLabel}
        <span class="workspace-status">{statusLabel}</span>
      {/if}
    </div>
    <span title={cwd}>{cwd}</span>
  </div>
  {#if showTools}
    <div class="terminal-controls">
      <div class="terminal-tools" role="group" aria-label="Terminal tools">
        <Button
          id={backgroundTriggerId}
          variant="icon"
          class={`background-button${backgroundOpen ? ' active' : ''}`}
          onclick={toggleBackground}
          ariaLabel={backgroundOpen ? 'Close background processes' : 'Open background processes'}
          title={backgroundOpen ? 'Close background processes' : 'Open background processes'}
          ariaExpanded={backgroundOpen}
          ariaControls={backgroundPanelId}
        >
          <Activity size={16} strokeWidth={1.8} aria-hidden="true" />
          {#if backgroundCount > 0}
            <span>{backgroundCount > 99 ? '99+' : backgroundCount}</span>
          {/if}
        </Button>
        <Button
          variant="icon"
          class={`note-button${hasNote ? ' has-note' : ''}${noteOpen ? ' active' : ''}`}
          onclick={toggleNote}
          ariaLabel={noteOpen ? 'Close workspace note' : hasNote ? 'Open workspace note' : 'Add workspace note'}
          title={noteOpen ? 'Close workspace note' : hasNote ? 'Open workspace note' : 'Add workspace note'}
          ariaExpanded={noteOpen}
        >
          <StickyNote size={16} strokeWidth={1.8} aria-hidden="true" />
        </Button>
        <Button
          variant="icon"
          class={`repository-button${repositoryOpen ? ' active' : ''}`}
          onclick={toggleRepository}
          ariaLabel={repositoryOpen
            ? isGitRepository === false
              ? 'Close workspace files'
              : 'Close repository'
            : isGitRepository === false
              ? 'Open workspace files'
              : 'Open repository'}
          title={repositoryOpen
            ? isGitRepository === false
              ? 'Close workspace files'
              : 'Close repository'
            : isGitRepository === false
              ? 'Open workspace files'
              : 'Open repository'}
          ariaExpanded={repositoryOpen}
        >
          <ListTree size={16} strokeWidth={1.8} aria-hidden="true" />
          {#if isGitRepository && changeCount > 0}
            <span aria-label={`${changeCount} changed files`}>{changeCount > 99 ? '99+' : changeCount}</span>
          {/if}
        </Button>
      </div>
    </div>
  {/if}
</header>

<style>
.terminal-header {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.75rem;
  min-width: 0;
  padding: max(0.65rem, env(safe-area-inset-top)) max(0.75rem, env(safe-area-inset-right)) 0.65rem
    max(0.75rem, env(safe-area-inset-left));
  background: var(--color-panel);
}
:global(.back-button) {
  display: grid;
  align-items: center;
  justify-content: center;
  width: var(--control-size-icon);
  min-width: var(--control-size-icon);
  min-height: var(--control-size-icon);
  height: var(--control-size-icon);
  padding: 0;
  border: 1px solid var(--color-border);
  border-radius: 0.55rem;
  background: var(--color-control-background);
  color: var(--color-text);
  font: inherit;
  font-weight: var(--weight-medium);
  cursor: pointer;
}
.terminal-identity {
  display: grid;
  min-width: 0;
  justify-items: center;
  gap: 0.34rem;
}
.terminal-identity-title {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  min-width: 0;
  max-width: 100%;
}
.terminal-identity-title strong {
  min-width: 0;
  overflow: hidden;
  font-size: var(--text-body);
  font-weight: var(--weight-medium);
  line-height: var(--leading-tight);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.workspace-status {
  flex: 0 0 auto;
  padding: 0.08rem 0.3rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  background: var(--color-surface-raised);
  color: var(--color-text-secondary);
  font-size: var(--text-nano);
  line-height: 1.25;
}
.terminal-identity > span {
  max-width: 100%;
  overflow: hidden;
  color: var(--color-text-tertiary);
  font-family: var(--font-mono);
  font-size: var(--text-caption);
  line-height: var(--leading-tight);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.branch-label {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  gap: 0.2rem;
  color: var(--color-text-tertiary);
  font-size: var(--text-nano);
  line-height: 1.25;
}
.branch-label > span {
  overflow: hidden;
  max-width: 12rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.working-copy-missing {
  flex: 0 0 auto;
  padding: 0.08rem 0.3rem;
  border: 1px solid var(--color-warning-accent);
  border-radius: var(--radius-pill);
  color: var(--color-warning-accent);
  font-size: var(--text-nano);
  line-height: 1.25;
}
.terminal-controls {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 0.5rem;
  min-width: max-content;
}
.terminal-tools {
  display: flex;
  align-items: center;
  gap: 0.15rem;
}
:global(.note-button),
:global(.background-button),
:global(.repository-button) {
  position: relative;
  display: grid;
  place-items: center;
  width: 2.35rem;
  min-width: 2.35rem;
  height: 2.35rem;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--color-text-tertiary);
  font: inherit;
  cursor: pointer;
}
:global(.note-button:focus-visible),
:global(.background-button:focus-visible),
:global(.note-button.active),
:global(.background-button.active),
:global(.repository-button.active),
:global(.repository-button:focus-visible) {
  border-color: var(--color-border-strong);
  background: transparent;
  color: var(--color-text);
  outline: none;
}

@media (hover: hover) {
  :global(.back-button:hover) {
    background: var(--color-surface-hover);
  }
  :global(.note-button:hover),
  :global(.background-button:hover),
  :global(.repository-button:hover) {
    border-color: var(--color-border-strong);
    background: transparent;
    color: var(--color-text);
    outline: none;
  }
}
:global(.background-button span),
:global(.repository-button span) {
  position: absolute;
  z-index: 1;
  top: -0.18rem;
  right: -0.28rem;
  display: grid;
  place-items: center;
  min-width: 1.15rem;
  height: 1.15rem;
  padding: 0 0.24rem;
  border-radius: var(--radius-pill);
  background: var(--color-accent);
  box-shadow: 0 0 0 2px var(--color-panel);
  color: var(--color-accent-ink);
  font-size: var(--text-nano);
  font-weight: var(--weight-strong);
  font-variant-numeric: tabular-nums;
  pointer-events: none;
}
:global(.note-button.has-note) {
  color: var(--color-command);
}
:global(.note-button.has-note::after) {
  position: absolute;
  top: 0.38rem;
  right: 0.38rem;
  width: 0.32rem;
  height: 0.32rem;
  border-radius: 50%;
  background: var(--color-accent);
  content: "";
}
.terminal-header-no-tools {
  grid-template-columns: minmax(0, 1fr);
}
@media (min-width: 64rem) {
  .terminal-header {
    grid-template-columns: minmax(0, 1fr) auto;
  }
  :global(.back-button) {
    display: none !important;
  }
  .terminal-identity {
    justify-items: start;
  }
  .terminal-header {
    padding-block: 0.8rem;
  }
  .terminal-header-no-tools {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 63.999rem) {
  .terminal-header {
    gap: 0.5rem;
  }
  .terminal-header-no-tools {
    grid-template-columns: auto minmax(0, 1fr);
  }
  :global(.back-button) {
    display: grid;
    width: var(--control-size-icon);
    min-width: var(--control-size-icon);
    min-height: var(--control-size-icon);
    height: var(--control-size-icon);
    padding: 0;
    justify-content: center;
  }
  .terminal-identity > span {
    display: none;
  }
  .terminal-identity {
    justify-items: start;
  }
}

@media (max-width: 32rem) {
  .terminal-header {
    grid-template-columns: var(--control-size-icon) minmax(0, 1fr) auto;
    gap: 0.35rem;
    padding-inline: max(0.5rem, env(safe-area-inset-left)) max(0.5rem, env(safe-area-inset-right));
  }
  .terminal-header-no-tools {
    grid-template-columns: var(--control-size-icon) minmax(0, 1fr);
  }
  :global(.back-button) {
    width: var(--control-size-icon);
    min-width: var(--control-size-icon);
    min-height: var(--control-size-icon);
    height: var(--control-size-icon);
  }
  .terminal-identity-title {
    gap: 0.3rem;
  }
  .branch-label {
    display: none;
  }
  .terminal-controls,
  .terminal-tools {
    gap: 0;
  }
  :global(.note-button),
  :global(.background-button),
  :global(.repository-button) {
    width: 2.75rem;
    min-width: 2.75rem;
    height: 2.75rem;
  }
}

@media (max-width: 22rem) {
  .terminal-identity-title strong,
  .working-copy-missing {
    display: none;
  }
}
</style>
