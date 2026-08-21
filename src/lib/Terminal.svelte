<script lang="ts">
import { onMount, type Snippet } from 'svelte';
import type { ManagedSession, SessionTerminal } from '$lib/session/types';
import { isWorktreeWorkspace, workspaceName, workspaceRepositoryName } from '$lib/session/view';
import BackgroundProcesses from '$lib/terminal/BackgroundProcesses.svelte';
import GlobalStatusBar from '$lib/status/GlobalStatusBar.svelte';
import TerminalHeader from '$lib/terminal/TerminalHeader.svelte';
import TerminalViewport from '$lib/terminal/TerminalViewport.svelte';
import type { StatusPluginSnapshot } from '$lib/status/status-plugin';
import { isDesktopViewport } from '$lib/ui/layout';
import type { TerminalPathInsertionRequest, WorkspaceEntryDragData } from '$lib/workspace-entry-drag.ts';

let {
  session,
  onStartBackground,
  onStopBackground,
  onLoadBackgroundOutput,
  onFavoriteBackground,
  onRemoveBackgroundFavorite,
  startingBackground = false,
  stoppingBackgroundProcessId,
  updatingFavoriteCommand,
  backgroundActionError = '',
  close,
  onInputActivity = () => undefined,
  onOutputActivity = () => undefined,
  repositoryOpen = false,
  isGitRepository = undefined,
  changeCount = 0,
  worktreeCount = 0,
  onRepositoryStatus = () => undefined,
  onToggleRepository = () => undefined,
  onToggleNote = () => undefined,
  noteOpen = false,
  pathInsertionRequest,
  onExternalFileDrop = async () => [],
  statusPlugins = [],
  children,
}: {
  session: ManagedSession;
  onStartBackground: (command: string) => Promise<SessionTerminal | undefined>;
  onStopBackground: (process: SessionTerminal) => Promise<boolean>;
  onLoadBackgroundOutput: (processId: string) => Promise<string>;
  onFavoriteBackground: (command: string) => Promise<boolean>;
  onRemoveBackgroundFavorite: (command: string) => Promise<boolean>;
  startingBackground?: boolean;
  stoppingBackgroundProcessId?: string;
  updatingFavoriteCommand?: string;
  backgroundActionError?: string;
  close: () => void;
  onInputActivity?: (sessionId: string, timestamp: number) => void;
  onOutputActivity?: (sessionId: string, active: boolean, timestamp?: number) => void;
  repositoryOpen?: boolean;
  isGitRepository?: boolean;
  changeCount?: number;
  worktreeCount?: number;
  onRepositoryStatus?: (changeCount: number, worktreeCount: number) => void;
  onToggleRepository?: () => void;
  onToggleNote?: () => void;
  noteOpen?: boolean;
  pathInsertionRequest?: TerminalPathInsertionRequest;
  onExternalFileDrop?: (dataTransfer: DataTransfer) => Promise<WorkspaceEntryDragData[]>;
  statusPlugins?: StatusPluginSnapshot[];
  children?: Snippet;
} = $props();

let viewportStyle = $state('');
let terminalFontSize = $state(14);
let backgroundOpen = $state(false);
const minimumFontSize = 10;
const maximumFontSize = 22;
const projectName = $derived(workspaceName(session));
const worktreeWorkspace = $derived(isWorktreeWorkspace(session));
const repositoryName = $derived(workspaceRepositoryName(session));
const orderedTerminals = $derived([...session.terminals].sort((left, right) => left.index - right.index));
const mainTerminal = $derived(orderedTerminals[0]);
const backgroundProcesses = $derived(orderedTerminals.slice(1));
const backgroundPanelId = $derived(`background-manager-${session.id}`);
const backgroundTriggerId = $derived(`background-trigger-${session.id}`);

onMount(() => {
  const updateViewport = () => {
    if (isDesktopViewport()) {
      viewportStyle = '';
      return;
    }
    const viewport = window.visualViewport;
    const height = Math.round(viewport?.height ?? window.innerHeight);
    const top = Math.round(viewport?.offsetTop ?? 0);
    viewportStyle = `--terminal-viewport-height: ${height}px; --terminal-viewport-top: ${top}px;`;
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

<section class="terminal-sheet" style={viewportStyle} aria-label={`Terminal for ${projectName}`}>
  <div class="terminal-topbar">
    <GlobalStatusBar plugins={statusPlugins} />
    <TerminalHeader
      {projectName}
      cwd={session.cwd}
      isWorktree={worktreeWorkspace}
      {repositoryName}
      worktreeBranch={session.worktreeBranch}
      hasNote={Boolean(session.notePreview)}
      {noteOpen}
      {close}
      {repositoryOpen}
      {isGitRepository}
      workspaceAvailable={session.workspaceAvailable !== false}
      {changeCount}
      {worktreeCount}
      {backgroundOpen}
      backgroundCount={backgroundProcesses.length}
      {backgroundPanelId}
      {backgroundTriggerId}
      toggleRepository={onToggleRepository}
      toggleNote={onToggleNote}
      toggleBackground={() => (backgroundOpen = !backgroundOpen)}
    ></TerminalHeader>
    <BackgroundProcesses
      open={backgroundOpen}
      onOpenChange={(open) => (backgroundOpen = open)}
      panelId={backgroundPanelId}
      triggerId={backgroundTriggerId}
      processes={backgroundProcesses}
      favoriteCommands={session.favoriteCommands}
      starting={startingBackground}
      stoppingProcessId={stoppingBackgroundProcessId}
      {updatingFavoriteCommand}
      actionError={backgroundActionError}
      onStart={onStartBackground}
      onStop={onStopBackground}
      onLoadOutput={onLoadBackgroundOutput}
      onFavorite={onFavoriteBackground}
      onRemoveFavorite={onRemoveBackgroundFavorite}
    />
  </div>

  {#key mainTerminal?.id}
    <div class="main-session-terminal">
      <TerminalViewport
        sessionId={session.id}
        terminalId={mainTerminal?.id}
        {onInputActivity}
        {onOutputActivity}
        {onRepositoryStatus}
        {pathInsertionRequest}
        {onExternalFileDrop}
        bind:fontSize={terminalFontSize}
        {minimumFontSize}
        {maximumFontSize}
      >
        {#if children}
          {@render children()}
        {/if}
      </TerminalViewport>
    </div>
  {/key}
</section>

<style>
.terminal-sheet {
  position: fixed;
  z-index: 20;
  top: var(--terminal-viewport-top, 0);
  left: 0;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  width: 100%;
  height: var(--terminal-viewport-height, 100dvh);
  min-width: 0;
  overflow: hidden;
  background: var(--color-terminal-background);
  color: var(--color-terminal-foreground);
}
.terminal-topbar {
  position: relative;
  z-index: 7;
  min-width: 0;
}
.main-session-terminal {
  display: grid;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

@media (min-width: 64rem) {
  .terminal-sheet {
    position: relative;
    z-index: 1;
    top: auto;
    height: 100%;
    min-height: 0;
    border: 0;
    border-radius: 0;
  }
}
</style>
