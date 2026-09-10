<script lang="ts">
import type { Snippet } from 'svelte';
import type { ManagedWorkspace } from '~/lib/shared/contracts/workspace';
import { isWorktreeWorkspace, workspaceName } from '~/lib/features/workspace/model/workspace-view';
import GlobalStatusBar from './GlobalStatusBar.svelte';
import TerminalHeader from '~/lib/features/terminal/ui/TerminalHeader.svelte';
import TerminalViewport from '~/lib/features/terminal/ui/TerminalViewport.svelte';
import type { StatusPluginSnapshot } from '~/lib/shared/contracts/status-plugin';
import type { TerminalPathInsertionRequest, WorkspaceEntryDragData } from '~/lib/shared/lib/workspace-entry-drag.ts';
import type { WorkspaceComposerPrompt } from '~/lib/shared/contracts/workspace-composer-history.ts';

let {
  workspace,
  backgroundOpen = false,
  onToggleBackground = () => undefined,
  close,
  onInputActivity = () => undefined,
  onOutputActivity = () => undefined,
  composerHistoryEnabled = true,
  onRecordComposerPrompt,
  onLoadComposerPrompts,
  repositoryOpen = false,
  isGitRepository = undefined,
  changeCount = 0,
  worktreeCount = 0,
  repositoryBranch,
  onRepositoryStatus = () => undefined,
  onToggleRepository = () => undefined,
  onToggleNote = () => undefined,
  noteOpen = false,
  pathInsertionRequest,
  onExternalFileDrop = async () => [],
  statusPlugins = [],
  dismissStatusPopovers = false,
  onManageStatusWidgets = () => undefined,
  children,
}: {
  workspace: ManagedWorkspace;
  backgroundOpen?: boolean;
  onToggleBackground?: () => void;
  close: () => void;
  onInputActivity?: (workspaceId: string, timestamp: number) => void;
  onOutputActivity?: (workspaceId: string, active: boolean, timestamp?: number) => void;
  composerHistoryEnabled?: boolean;
  onRecordComposerPrompt: (workspaceId: string, prompt: string) => Promise<void>;
  onLoadComposerPrompts: (workspaceId: string, refresh?: boolean) => Promise<WorkspaceComposerPrompt[]>;
  repositoryOpen?: boolean;
  isGitRepository?: boolean;
  changeCount?: number;
  worktreeCount?: number;
  repositoryBranch?: string;
  onRepositoryStatus?: (changeCount: number, worktreeCount: number, branch?: string) => void;
  onToggleRepository?: () => void;
  onToggleNote?: () => void;
  noteOpen?: boolean;
  pathInsertionRequest?: TerminalPathInsertionRequest;
  onExternalFileDrop?: (dataTransfer: DataTransfer) => Promise<WorkspaceEntryDragData[]>;
  statusPlugins?: StatusPluginSnapshot[];
  dismissStatusPopovers?: boolean;
  onManageStatusWidgets?: () => void;
  children?: Snippet;
} = $props();

let terminalFontSize = $state(14);
const minimumFontSize = 10;
const maximumFontSize = 22;
const projectName = $derived(workspaceName(workspace));
const worktreeWorkspace = $derived(isWorktreeWorkspace(workspace));
const orderedTerminals = $derived([...workspace.terminals].sort((left, right) => left.index - right.index));
const mainTerminal = $derived(orderedTerminals[0]);
const backgroundProcesses = $derived(orderedTerminals.slice(1));
const backgroundPanelId = $derived(`background-manager-${workspace.id}`);
const backgroundTriggerId = $derived(`background-trigger-${workspace.id}`);
</script>

<section class="terminal-sheet" aria-label={`Terminal for ${projectName}`}>
  <div class="terminal-topbar">
    <GlobalStatusBar plugins={statusPlugins} dismissPopovers={dismissStatusPopovers} {onManageStatusWidgets} />
    <TerminalHeader
      {projectName}
      cwd={workspace.cwd}
      isWorktree={worktreeWorkspace}
      branch={repositoryBranch ?? workspace.worktreeBranch}
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
      toggleBackground={onToggleBackground}
    ></TerminalHeader>
  </div>

  {#key mainTerminal?.id}
    <div class="main-workspace-terminal">
      <TerminalViewport
        workspaceId={workspace.id}
        terminalId={mainTerminal?.id}
        composerTemplate={workspace.composerTemplate}
        composerTemplateContext={{ workspace: { name: projectName, cwd: workspace.cwd } }}
        {onInputActivity}
        {onOutputActivity}
        {composerHistoryEnabled}
        {onRecordComposerPrompt}
        {onLoadComposerPrompts}
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
  position: relative;
  z-index: 1;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
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
  width: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

@media (max-height: 360px) {
  .terminal-topbar :global(.global-status-shell) {
    display: none;
  }
  .terminal-topbar :global(.terminal-header) {
    padding-block: max(0.15rem, env(safe-area-inset-top)) 0.15rem;
  }
  .main-workspace-terminal :global(.xterm) {
    padding-block: 4px;
  }
}
</style>
