<script lang="ts">
import { onMount, type Snippet } from 'svelte';
import type { ManagedWorkspace, WorkspaceTerminal } from '~/lib/shared/contracts/workspace';
import {
  isWorktreeWorkspace,
  workspaceName,
  workspaceRepositoryName,
} from '~/lib/features/workspace/model/workspace-view';
import BackgroundProcesses from '~/lib/features/terminal/ui/BackgroundProcesses.svelte';
import WorkspaceAgentTabs from '~/lib/features/terminal/ui/WorkspaceAgentTabs.svelte';
import KingWorkflowPanel from '~/lib/features/workspace/ui/KingWorkflowPanel.svelte';
import WorkspaceKingControlPanel from '~/lib/features/workspace/ui/WorkspaceKingControlPanel.svelte';
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
  kingAvailable = false,
  onKingControlChange = () => undefined,
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
  kingAvailable?: boolean;
  onKingControlChange?: (control: NonNullable<ManagedWorkspace['kingControl']>) => void;
  children?: Snippet;
} = $props();

let viewportStyle = $state('');
let terminalFontSize = $state(14);
let backgroundOpen = $state(false);
let selectedTerminalId = $state<string>();
const minimumFontSize = 10;
const maximumFontSize = 22;

function selectMainTerminal(terminals: WorkspaceTerminal[]): WorkspaceTerminal | undefined {
  return (
    terminals.find((terminal) => terminal.terminalKind === 'main') ??
    terminals.find((terminal) => terminal.terminalKind === undefined)
  );
}

function isBackgroundTerminal(terminal: WorkspaceTerminal, main: WorkspaceTerminal | undefined): boolean {
  return terminal.id !== main?.id && terminal.terminalKind !== 'king-task';
}

const projectName = $derived(workspaceName(workspace));
const kingWorkspace = $derived(workspace.workspaceKind === 'king');
const worktreeWorkspace = $derived(isWorktreeWorkspace(workspace));
const repositoryName = $derived(workspaceRepositoryName(workspace));
const orderedTerminals = $derived([...workspace.terminals].sort((left, right) => left.index - right.index));
const mainTerminal = $derived(selectMainTerminal(orderedTerminals));
const kingTaskTerminals = $derived(orderedTerminals.filter((terminal) => terminal.terminalKind === 'king-task'));
const selectedTerminal = $derived(
  orderedTerminals.find((terminal) => terminal.id === selectedTerminalId) ?? mainTerminal ?? kingTaskTerminals[0]
);
const backgroundProcesses = $derived(
  orderedTerminals.filter((terminal) => isBackgroundTerminal(terminal, mainTerminal))
);
const inputEnabled = $derived(
  selectedTerminal?.terminalKind !== 'king-task' && workspace.kingControl?.state !== 'king'
);
const inputDisabledReason = $derived(
  selectedTerminal?.terminalKind === 'king-task'
    ? 'King agent terminals are read-only here. Use Stop in the workspace agent bar to end the Attempt.'
    : 'King controls this checkout. Take control from the crown menu to use the main terminal.'
);
const backgroundPanelId = $derived(`background-manager-${workspace.id}`);
const backgroundTriggerId = $derived(`background-trigger-${workspace.id}`);

$effect(() => {
  if (selectedTerminalId && orderedTerminals.some((terminal) => terminal.id === selectedTerminalId)) return;
  selectedTerminalId = mainTerminal?.id ?? kingTaskTerminals[0]?.id;
});

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
      isKing={kingWorkspace}
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
    >
      {#snippet orchestrationTools()}
        {#if kingWorkspace}
          <KingWorkflowPanel />
        {:else if kingAvailable}
          <WorkspaceKingControlPanel {workspace} onControlChange={onKingControlChange} />
        {/if}
      {/snippet}
    </TerminalHeader>
    <WorkspaceAgentTabs
      workspaceId={workspace.id}
      {mainTerminal}
      taskTerminals={kingTaskTerminals}
      {selectedTerminalId}
      onSelect={(terminalId) => (selectedTerminalId = terminalId)}
    />
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

  {#key selectedTerminal?.id}
    <div class="main-workspace-terminal">
      <TerminalViewport
        workspaceId={workspace.id}
        terminalId={selectedTerminal?.id}
        {onInputActivity}
        {onOutputActivity}
        {onRepositoryStatus}
        {pathInsertionRequest}
        {onExternalFileDrop}
        bind:fontSize={terminalFontSize}
        {inputEnabled}
        {inputDisabledReason}
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
