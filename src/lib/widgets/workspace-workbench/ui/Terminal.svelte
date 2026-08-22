<script lang="ts">
import { onMount, type Snippet } from 'svelte';
import type { ManagedWorkspace, WorkspaceTerminal } from '~/lib/shared/contracts/workspace';
import {
  isWorktreeWorkspace,
  workspaceName,
  workspaceRepositoryName,
} from '~/lib/features/workspace/model/workspace-view';
import BackgroundProcesses from '~/lib/features/terminal/ui/BackgroundProcesses.svelte';
import GlobalStatusBar from './GlobalStatusBar.svelte';
import TerminalHeader from '~/lib/features/terminal/ui/TerminalHeader.svelte';
import TerminalViewport from '~/lib/features/terminal/ui/TerminalViewport.svelte';
import type { StatusPluginSnapshot } from '~/lib/shared/contracts/status-plugin';
import { isDesktopViewport } from '~/lib/shared/ui/layout';
import type { TerminalPathInsertionRequest, WorkspaceEntryDragData } from '~/lib/shared/lib/workspace-entry-drag.ts';

let {
  workspace,
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
  onLogout,
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
  dismissStatusPopovers = false,
  children,
}: {
  workspace: ManagedWorkspace;
  onStartBackground: (command: string) => Promise<WorkspaceTerminal | undefined>;
  onStopBackground: (process: WorkspaceTerminal) => Promise<boolean>;
  onLoadBackgroundOutput: (processId: string) => Promise<string>;
  onFavoriteBackground: (command: string) => Promise<boolean>;
  onRemoveBackgroundFavorite: (command: string) => Promise<boolean>;
  startingBackground?: boolean;
  stoppingBackgroundProcessId?: string;
  updatingFavoriteCommand?: string;
  backgroundActionError?: string;
  close: () => void;
  onLogout?: () => void;
  onInputActivity?: (workspaceId: string, timestamp: number) => void;
  onOutputActivity?: (workspaceId: string, active: boolean, timestamp?: number) => void;
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
  dismissStatusPopovers?: boolean;
  children?: Snippet;
} = $props();

let viewportStyle = $state('');
let terminalFontSize = $state(14);
let backgroundOpen = $state(false);
const minimumFontSize = 10;
const maximumFontSize = 22;
const projectName = $derived(workspaceName(workspace));
const worktreeWorkspace = $derived(isWorktreeWorkspace(workspace));
const repositoryName = $derived(workspaceRepositoryName(workspace));
const orderedTerminals = $derived([...workspace.terminals].sort((left, right) => left.index - right.index));
const mainTerminal = $derived(orderedTerminals[0]);
const backgroundProcesses = $derived(orderedTerminals.slice(1));
const backgroundPanelId = $derived(`background-manager-${workspace.id}`);
const backgroundTriggerId = $derived(`background-trigger-${workspace.id}`);

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
    <GlobalStatusBar plugins={statusPlugins} {onLogout} dismissPopovers={dismissStatusPopovers} />
    <TerminalHeader
      {projectName}
      cwd={workspace.cwd}
      isWorktree={worktreeWorkspace}
      {repositoryName}
      worktreeBranch={workspace.worktreeBranch}
      hasNote={Boolean(workspace.notePreview)}
      {noteOpen}
      {close}
      {repositoryOpen}
      {isGitRepository}
      workspaceAvailable={workspace.workspaceAvailable !== false}
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
      favoriteCommands={workspace.favoriteCommands}
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
    <div class="main-workspace-terminal">
      <TerminalViewport
        workspaceId={workspace.id}
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
.main-workspace-terminal {
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
