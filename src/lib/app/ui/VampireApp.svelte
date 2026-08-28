<script lang="ts">
import { dev } from '$app/environment';
import { pushState } from '$app/navigation';
import { onMount } from 'svelte';
import ChevronDown from '@lucide/svelte/icons/chevron-down';
import CircleHelp from '@lucide/svelte/icons/circle-help';
import Keyboard from '@lucide/svelte/icons/keyboard';
import SquarePlay from '@lucide/svelte/icons/square-play';
import SquareTerminal from '@lucide/svelte/icons/square-terminal';
import LoginScreen from '~/lib/features/auth/ui/LoginScreen.svelte';
import TmuxSetupScreen from '~/lib/features/system/ui/TmuxSetupScreen.svelte';
import DropdownMenuShell from '~/lib/shared/ui/DropdownMenuShell.svelte';
import DropdownMenuItem from '~/lib/shared/ui/DropdownMenuItem.svelte';
import Button from '~/lib/shared/ui/Button.svelte';
import Spinner from '~/lib/shared/ui/Spinner.svelte';
import { isUiOverlayOpen } from '~/lib/shared/ui/overlay';
import { WorkspaceConnectionState } from '~/lib/app/model/workspace-connection-state.svelte';
import WorkspaceWorkbench from '~/lib/widgets/workspace-workbench/ui/WorkspaceWorkbench.svelte';
import type { RepositoryTab } from '~/lib/shared/contracts/repository';
import NewWorktreeDialog from '~/lib/features/workspace/ui/NewWorktreeDialog.svelte';
import WorkspaceNavigator from '~/lib/features/workspace/ui/WorkspaceNavigator.svelte';
import WorkspaceAliasDialog from '~/lib/features/workspace/ui/WorkspaceAliasDialog.svelte';
import WorkspaceAutomationsDialog from '~/lib/widgets/workspace-workbench/ui/WorkspaceAutomationsDialog.svelte';
import WorkspaceSettings from '~/lib/features/workspace/ui/WorkspaceSettings.svelte';
import { WorkspaceState } from '~/lib/features/workspace/model/workspace-state.svelte';
import type { ManagedWorkspace, MobilePanel } from '~/lib/shared/contracts/workspace';
import {
  isWorktreeWorkspace,
  workspaceName,
  workspaceRepositoryName,
} from '~/lib/features/workspace/model/workspace-view';
import { REPOSITORY_SPLIT_MEDIA_QUERY } from '~/lib/shared/ui/layout';
import TerminalHeader from '~/lib/features/terminal/ui/TerminalHeader.svelte';

let { initialWorkspaceId = undefined }: { initialWorkspaceId?: string } = $props();

let mobilePanel = $state<MobilePanel | undefined>(undefined);
let repositoryPanelOpen = $state(false);
let repositoryTab = $state<RepositoryTab>('files');
let workspaceSettingsOpen = $state(false);
let reopenWithOpen = $state(false);
let workspaceAliasWorkspace = $state<ManagedWorkspace>();
let workspaceAutomationsWorkspace = $state<ManagedWorkspace>();
let worktreeSourceWorkspace = $state<ManagedWorkspace>();
let presentedTerminalWorkspaceId = $state<string | undefined>(undefined);
let workspaceShortcutModifier = $state('Ctrl');
let previewTmuxUnavailable = $state(false);
let useMetaWorkspaceShortcuts = false;
const REPOSITORY_TAB_KEY = 'vampire:repository-tab';

const connection = new WorkspaceConnectionState();
const tmuxStatus = $derived(
  connection.tmuxStatus && previewTmuxUnavailable
    ? { ...connection.tmuxStatus, available: false, version: null }
    : connection.tmuxStatus
);
const workspaceState: WorkspaceState = new WorkspaceState({
  navigate: (path) => pushState(path, {}),
  onUnauthorized: () => connection.markUnauthenticated(),
  isWorkspaceObserved: (workspaceId) => terminalIsObserved(workspaceId),
});
function terminalIsObserved(workspaceId: string): boolean {
  return (
    workspaceState.requestedWorkspaceId === workspaceId &&
    presentedTerminalWorkspaceId === workspaceId &&
    document.visibilityState === 'visible' &&
    mobilePanel === undefined &&
    !workspaceSettingsOpen &&
    !workspaceAliasWorkspace &&
    !worktreeSourceWorkspace &&
    !workspaceAutomationsWorkspace
  );
}

function setTerminalPresentation(workspaceId: string, presented: boolean) {
  if (presented) {
    presentedTerminalWorkspaceId = workspaceId;
    markActiveWorkspaceObserved();
    return;
  }
  if (presentedTerminalWorkspaceId !== workspaceId) return;
  if (terminalIsObserved(workspaceId)) workspaceState.markWorkspaceObserved(workspaceId);
  presentedTerminalWorkspaceId = undefined;
}

function markActiveWorkspaceObserved() {
  if (workspaceState.requestedWorkspaceId && terminalIsObserved(workspaceState.requestedWorkspaceId)) {
    workspaceState.markWorkspaceObserved(workspaceState.requestedWorkspaceId);
  }
}

function setMobilePanel(panel: MobilePanel | undefined) {
  if (mobilePanel === undefined && panel !== undefined) markActiveWorkspaceObserved();
  mobilePanel = panel;
  if (panel === undefined) markActiveWorkspaceObserved();
}

function setRepositoryPanelOpen(open: boolean) {
  repositoryPanelOpen = open;
  if (!open && mobilePanel === 'repository') setMobilePanel(undefined);
}

function setRepositoryTab(tab: RepositoryTab) {
  repositoryTab = tab;
  window.localStorage.setItem(REPOSITORY_TAB_KEY, tab);
}

function isRepositorySplitViewport(): boolean {
  return window.matchMedia(REPOSITORY_SPLIT_MEDIA_QUERY).matches;
}

function restorePanelAfterWorkspaceChange() {
  setMobilePanel(repositoryPanelOpen && !isRepositorySplitViewport() ? 'repository' : undefined);
}

function unlock() {
  return connection.unlock();
}

async function logout() {
  if (!(await connection.logout())) return;
  workspaceState.reset();
  workspaceSettingsOpen = false;
  reopenWithOpen = false;
  workspaceAliasWorkspace = undefined;
  worktreeSourceWorkspace = undefined;
  workspaceAutomationsWorkspace = undefined;
  repositoryPanelOpen = false;
  mobilePanel = 'workspaces';
  pushState('/', {});
}

function openWorkspace(managedWorkspace: ManagedWorkspace) {
  workspaceSettingsOpen = false;
  reopenWithOpen = false;
  workspaceAliasWorkspace = undefined;
  worktreeSourceWorkspace = undefined;
  workspaceAutomationsWorkspace = undefined;
  workspaceState.openWorkspace(managedWorkspace);
  restorePanelAfterWorkspaceChange();
}

function openStartupProfile(managedWorkspace: ManagedWorkspace) {
  workspaceAliasWorkspace = undefined;
  worktreeSourceWorkspace = undefined;
  workspaceAutomationsWorkspace = undefined;
  if (workspaceState.requestedWorkspaceId !== managedWorkspace.id) {
    workspaceState.openWorkspace(managedWorkspace);
    restorePanelAfterWorkspaceChange();
  }
  repositoryPanelOpen = false;
  mobilePanel = undefined;
  workspaceSettingsOpen = true;
}

function openWorkspaceAlias(managedWorkspace: ManagedWorkspace) {
  workspaceSettingsOpen = false;
  worktreeSourceWorkspace = undefined;
  workspaceAutomationsWorkspace = undefined;
  workspaceAliasWorkspace = managedWorkspace;
}

function openWorkspaceAutomations(managedWorkspace: ManagedWorkspace) {
  workspaceSettingsOpen = false;
  workspaceAliasWorkspace = undefined;
  worktreeSourceWorkspace = undefined;
  workspaceAutomationsWorkspace = managedWorkspace;
}

async function saveWorkspaceAlias(alias: string): Promise<{ ok: boolean; error?: string }> {
  const managedWorkspace = workspaceAliasWorkspace;
  if (!managedWorkspace) return { ok: false, error: 'Workspace is no longer available.' };
  return workspaceState.updateWorkspaceAlias(managedWorkspace.id, alias);
}

function openNewWorktree(managedWorkspace: ManagedWorkspace) {
  workspaceSettingsOpen = false;
  workspaceAliasWorkspace = undefined;
  workspaceAutomationsWorkspace = undefined;
  worktreeSourceWorkspace = managedWorkspace;
}

async function createIsolatedWorkspace(name: string): Promise<{ ok: boolean; error?: string }> {
  const source = worktreeSourceWorkspace;
  if (!source) return { ok: false, error: 'Source workspace is no longer available.' };
  const result = await workspaceState.createIsolatedWorkspace(source.id, name, tmuxStatus?.available);
  if (result.ok) {
    worktreeSourceWorkspace = undefined;
    restorePanelAfterWorkspaceChange();
  }
  return result;
}

async function createWorkspace() {
  if (await workspaceState.createWorkspace(tmuxStatus?.available)) restorePanelAfterWorkspaceChange();
}

function clearActiveWorkspace() {
  workspaceSettingsOpen = false;
  reopenWithOpen = false;
  workspaceAliasWorkspace = undefined;
  worktreeSourceWorkspace = undefined;
  workspaceAutomationsWorkspace = undefined;
  mobilePanel = 'workspaces';
  workspaceState.clearActiveWorkspace();
}

function openWorkspaceNavigator() {
  mobilePanel = 'workspaces';
}

function closeWorkspaceNavigator() {
  if (workspaceState.hasOpenWorkspace) restorePanelAfterWorkspaceChange();
}

function syncWorkspaceFromLocation(pathname = location.pathname) {
  workspaceState.syncLocation(pathname);
  if (workspaceState.requestedWorkspaceId) restorePanelAfterWorkspaceChange();
  else mobilePanel = 'workspaces';
  markActiveWorkspaceObserved();
}

async function restartWorkspace(
  managedWorkspace: ManagedWorkspace,
  launchProfileId?: string | null
): Promise<{ ok: boolean; error?: string }> {
  if (!(await workspaceState.restartWorkspace(managedWorkspace, launchProfileId))) {
    return { ok: false, error: workspaceState.workspaceActionError };
  }
  const restartedWorkspace = workspaceState.workspaces.find((candidate) => candidate.id === managedWorkspace.id);
  if (restartedWorkspace) openWorkspace(restartedWorkspace);
  return { ok: true };
}

async function closeWorkspace(managedWorkspace: ManagedWorkspace): Promise<{ ok: boolean; error?: string }> {
  const wasActive = workspaceState.requestedWorkspaceId === managedWorkspace.id;
  if (!(await workspaceState.closeWorkspace(managedWorkspace))) {
    return { ok: false, error: workspaceState.workspaceActionError };
  }
  if (workspaceAutomationsWorkspace?.id === managedWorkspace.id) workspaceAutomationsWorkspace = undefined;
  if (wasActive) mobilePanel = 'workspaces';
  return { ok: true };
}

async function removeWorkspace(managedWorkspace: ManagedWorkspace): Promise<{ ok: boolean; error?: string }> {
  const wasActive = workspaceState.requestedWorkspaceId === managedWorkspace.id;
  if (!(await workspaceState.removeWorkspace(managedWorkspace))) {
    return { ok: false, error: workspaceState.workspaceActionError };
  }
  if (workspaceAutomationsWorkspace?.id === managedWorkspace.id) workspaceAutomationsWorkspace = undefined;
  if (wasActive) mobilePanel = 'workspaces';
  return { ok: true };
}

function handleWorkspaceShortcut(event: KeyboardEvent) {
  const digitMatch = /^(?:Digit|Numpad)(\d)$/.exec(event.code);
  if (event.defaultPrevented || event.repeat || event.isComposing || event.shiftKey || !digitMatch) return;
  if (isUiOverlayOpen()) return;
  const primaryModifier = useMetaWorkspaceShortcuts ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  const fallbackModifier = event.altKey && !event.metaKey && !event.ctrlKey;
  if (!primaryModifier && !fallbackModifier) return;

  const digit = digitMatch[1];
  const index = digit === '0' ? 9 : Number(digit) - 1;
  const targetWorkspace = workspaceState.shortcutWorkspaces[index];
  if (!targetWorkspace) return;
  event.preventDefault();
  event.stopPropagation();
  openWorkspace(targetWorkspace);
}

function handleOverlayKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return;
  if (isUiOverlayOpen()) return;
  if (workspaceSettingsOpen) {
    event.preventDefault();
    workspaceSettingsOpen = false;
    return;
  }
  if (mobilePanel === 'workspaces' && workspaceState.hasOpenWorkspace) {
    event.preventDefault();
    closeWorkspaceNavigator();
  }
}

onMount(() => {
  const initialWorkspacePath = initialWorkspaceId ? `/workspaces/${encodeURIComponent(initialWorkspaceId)}` : '/';
  syncWorkspaceFromLocation(location.pathname || initialWorkspacePath);
  previewTmuxUnavailable = dev && new URLSearchParams(location.search).get('preview') === 'tmux';
  useMetaWorkspaceShortcuts = /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
  workspaceShortcutModifier = useMetaWorkspaceShortcuts ? '⌘' : 'Ctrl+';
  workspaceState.restoreBrowserPreferences(window.localStorage);
  const savedRepositoryTab = window.localStorage.getItem(REPOSITORY_TAB_KEY);
  if (savedRepositoryTab === 'changes' || savedRepositoryTab === 'files') repositoryTab = savedRepositoryTab;
  const stopConnection = connection.start({
    refreshWorkspaces: (options) => workspaceState.refresh(options),
    onVisible: markActiveWorkspaceObserved,
    onWorkspaceEvent: (event) => {
      if (event.type === 'workspaces-snapshot') {
        workspaceState.applyWorkspaceSnapshot(event.workspaces);
        if (event.preferences !== undefined) workspaceState.applyWorkspacePreferences(event.preferences);
        if (event.launchProfiles !== undefined) workspaceState.applyLaunchProfiles(event.launchProfiles);
        if (event.preferences !== undefined) {
          workspaceState.applyWorkspacePreferences(event.preferences, { initialSnapshot: true });
        }
        if (event.launchProfiles !== undefined) workspaceState.applyLaunchProfiles(event.launchProfiles);
      } else if (event.type === 'workspace-added') workspaceState.applyWorkspaceAdded(event.workspace);
      else if (event.type === 'workspace-updated') workspaceState.applyWorkspaceUpdated(event.id, event.changes);
      else if (event.type === 'workspace-removed') workspaceState.applyWorkspaceRemoved(event.id);
      else if (event.type === 'workspace-preferences-updated')
        workspaceState.applyWorkspacePreferences(event.preferences);
      else workspaceState.applyLaunchProfiles(event.launchProfiles);
    },
  });
  const handlePopState = () => syncWorkspaceFromLocation();
  const handleVisibilityChange = () => {
    const requestedWorkspaceId = workspaceState.requestedWorkspaceId;
    if (
      document.hidden &&
      requestedWorkspaceId &&
      requestedWorkspaceId === presentedTerminalWorkspaceId &&
      mobilePanel === undefined
    ) {
      workspaceState.markWorkspaceObserved(requestedWorkspaceId);
    } else if (!document.hidden) {
      markActiveWorkspaceObserved();
    }
  };
  window.addEventListener('popstate', handlePopState);
  window.addEventListener('keydown', handleWorkspaceShortcut, { capture: true });
  window.addEventListener('keydown', handleOverlayKeydown, { capture: true });
  document.addEventListener('visibilitychange', handleVisibilityChange);

  return () => {
    stopConnection();
    workspaceState.dispose();
    window.removeEventListener('popstate', handlePopState);
    window.removeEventListener('keydown', handleWorkspaceShortcut, { capture: true });
    window.removeEventListener('keydown', handleOverlayKeydown, { capture: true });
    document.removeEventListener('visibilitychange', handleVisibilityChange);
  };
});
</script>

<svelte:head>
  <meta name="description" content="A self-hosted browser workspace for persistent tmux-backed terminals.">
</svelte:head>

<main class:terminal-open={workspaceState.hasOpenWorkspace}>
  {#if connection.checking}
    <section class="loading-state" aria-live="polite">
      <Spinner />
      Connecting…
    </section>
  {:else if connection.authenticationRequired && !connection.authenticated}
    <LoginScreen
      token={connection.token}
      error={connection.loginError}
      onTokenChange={(token) => connection.token = token}
      onSubmit={() => void unlock()}
    />
  {:else if tmuxStatus?.available === false}
    <TmuxSetupScreen status={tmuxStatus} />
  {:else}
    <div class="app-shell">
      <div class="dashboard" class:terminal-open={workspaceState.hasOpenWorkspace}>
        <WorkspaceNavigator
          workspaces={workspaceState.workspaces}
          displayedWorkspaces={workspaceState.displayedWorkspaces}
          selectedWorkspaceId={workspaceState.activeWorkspace?.id}
          activityRecords={workspaceState.activityRecords}
          hasOpenWorkspace={workspaceState.hasOpenWorkspace}
          mobileOpen={mobilePanel === 'workspaces'}
          errorMessage={workspaceState.errorMessage || connection.errorMessage}
          workspaceOrderMode={workspaceState.workspaceOrderMode}
          workspacePreferencesError={workspaceState.workspacePreferencesError}
          bind:newWorkspaceOpen={workspaceState.newWorkspaceOpen}
          bind:cwd={workspaceState.cwd}
          starting={workspaceState.starting}
          startError={workspaceState.startError}
          tmuxAvailable={tmuxStatus?.available}
          onClose={closeWorkspaceNavigator}
          onOrderModeChange={(mode) => workspaceState.setWorkspaceOrderMode(mode)}
          onReorder={(draggedId, targetId, position) => workspaceState.reorderWorkspace(draggedId, targetId, position)}
          onOpen={openWorkspace}
          onSettings={openStartupProfile}
          onAlias={openWorkspaceAlias}
          onNewWorktree={openNewWorktree}
          onAutomations={openWorkspaceAutomations}
          workspaceAction={workspaceState.workspaceAction}
          onCloseWorkspace={closeWorkspace}
          onRemoveWorkspace={removeWorkspace}
          onCreate={() => void createWorkspace()}
        />

        {#if workspaceState.activeWorkspace?.state === 'missing'}
          <section class="unavailable-sheet" aria-labelledby="ended-workspace-title">
            <TerminalHeader
              projectName={workspaceName(workspaceState.activeWorkspace)}
              cwd={workspaceState.activeWorkspace.cwd}
              isWorktree={isWorktreeWorkspace(workspaceState.activeWorkspace)}
              repositoryName={workspaceRepositoryName(workspaceState.activeWorkspace)}
              worktreeBranch={workspaceState.activeWorkspace.worktreeBranch}
              hasNote={Boolean(workspaceState.activeWorkspace.notePreview)}
              noteOpen={false}
              statusLabel="Ended"
              showTools={false}
              close={openWorkspaceNavigator}
              repositoryOpen={true}
              isGitRepository={workspaceState.activeWorkspace.isGitRepository}
              workspaceAvailable={workspaceState.activeWorkspace.workspaceAvailable !== false}
              changeCount={0}
              worktreeCount={0}
              backgroundOpen={false}
              backgroundCount={0}
              backgroundPanelId={`ended-background-${workspaceState.activeWorkspace.id}`}
              backgroundTriggerId={`ended-background-trigger-${workspaceState.activeWorkspace.id}`}
              toggleRepository={() => undefined}
              toggleNote={() => undefined}
              toggleBackground={() => undefined}
            />
            <div class="unavailable-body">
              <span class="unavailable-icon" aria-hidden="true"><SquareTerminal size={22} strokeWidth={1.7} /></span>
              <p class="section-label">
                {workspaceState.activeWorkspace.workspaceAvailable === false ? 'working copy unavailable' : 'tmux session unavailable'}
              </p>
              <h2 id="ended-workspace-title">
                {workspaceState.activeWorkspace.workspaceAvailable === false ? 'This working copy was removed' : 'This shell has ended'}
              </h2>
              <p>
                {workspaceState.activeWorkspace.workspaceAvailable === false
							? 'The terminal has ended and its working directory no longer exists. Removing this entry does not delete the Git branch.'
							: 'The process is no longer running. You can open a fresh shell in the same project or remove this workspace from the list.'}
              </p>
              <code>{workspaceState.activeWorkspace.cwd}</code>
              <div class="unavailable-actions">
                {#if workspaceState.activeWorkspace.workspaceAvailable !== false}
                  <div class="unavailable-reopen-control">
                    <Button
                      class="unavailable-reopen-primary"
                      variant="primary"
                      onclick={() => void restartWorkspace(workspaceState.activeWorkspace!)}
                      disabled={Boolean(workspaceState.workspaceAction)}
                    >
                      {workspaceState.workspaceAction === 'restart' ? 'Reopening…' : 'Reopen shell'}
                    </Button>
                    <DropdownMenuShell
                      open={reopenWithOpen}
                      onOpenChange={(open) => reopenWithOpen = open}
                      triggerLabel="Reopen with…"
                      triggerTitle="Reopen with a different startup profile"
                      triggerClass="unavailable-reopen-menu-trigger"
                    >
                      {#snippet trigger()}
                        <ChevronDown size={16} strokeWidth={1.8} aria-hidden="true" />
                      {/snippet}

                      {#snippet children()}
                        <div class="unavailable-reopen-menu" role="group" aria-label="Reopen with">
                          <strong>Reopen with</strong>
                          <p>Runs once; it does not change the saved startup profile.</p>
                          <DropdownMenuItem
                            class="unavailable-reopen-option"
                            disabled={Boolean(workspaceState.workspaceAction)}
                            onSelect={() => void restartWorkspace(workspaceState.activeWorkspace!, null)}
                          >
                            <SquareTerminal size={16} strokeWidth={1.8} aria-hidden="true" />
                            <span class="unavailable-reopen-copy"><strong>Blank terminal</strong></span>
                          </DropdownMenuItem>
                          {#each workspaceState.launchProfiles as profile (profile.id)}
                            <DropdownMenuItem
                              class="unavailable-reopen-option"
                              disabled={Boolean(workspaceState.workspaceAction)}
                              onSelect={() => void restartWorkspace(workspaceState.activeWorkspace!, profile.id)}
                            >
                              <SquarePlay size={16} strokeWidth={1.8} aria-hidden="true" />
                              <span class="unavailable-reopen-copy">
                                <strong>{profile.name}</strong>
                                <span>{profile.command}</span>
                              </span>
                            </DropdownMenuItem>
                          {/each}
                        </div>
                      {/snippet}
                    </DropdownMenuShell>
                  </div>
                {/if}
                <Button
                  class="unavailable-remove-button"
                  variant="danger-outline"
                  onclick={() => void removeWorkspace(workspaceState.activeWorkspace!)}
                  disabled={Boolean(workspaceState.workspaceAction)}
                >
                  {workspaceState.workspaceAction === 'remove' ? 'Removing…' : 'Remove workspace'}
                </Button>
              </div>
              {#if workspaceState.workspaceActionError}
                <p class="error" role="alert">{workspaceState.workspaceActionError}</p>
              {/if}
            </div>
          </section>
        {:else if workspaceState.activeWorkspace}
          {#key workspaceState.activeWorkspace.id}
            <WorkspaceWorkbench
              workspace={workspaceState.activeWorkspace}
              onStartBackground={(command) => workspaceState.startBackgroundProcess(workspaceState.activeWorkspace!.id, command)}
              onStopBackground={(process) => workspaceState.stopBackgroundProcess(workspaceState.activeWorkspace!.id, process.id)}
              onLoadBackgroundOutput={(processId) => workspaceState.loadBackgroundOutput(workspaceState.activeWorkspace!.id, processId)}
              onFavoriteBackground={(command) => workspaceState.favoriteBackgroundCommand(workspaceState.activeWorkspace!.id, command)}
              onRemoveBackgroundFavorite={(command) => workspaceState.removeBackgroundCommandFavorite(workspaceState.activeWorkspace!.id, command)}
              startingBackground={workspaceState.startingBackgroundWorkspaceId === workspaceState.activeWorkspace.id}
              stoppingBackgroundProcessId={workspaceState.stoppingBackgroundProcessId}
              updatingFavoriteCommand={workspaceState.updatingFavoriteCommand}
              backgroundActionError={workspaceState.backgroundActionErrorWorkspaceId === workspaceState.activeWorkspace.id ? workspaceState.backgroundActionError : ''}
              onLogout={connection.authenticationRequired ? () => void logout() : undefined}
              close={openWorkspaceNavigator}
              onUpdateNote={(workspaceId, note) => workspaceState.updateWorkspaceNote(workspaceId, note)}
              onLoadNote={(workspaceId, refresh) => workspaceState.loadWorkspaceNote(workspaceId, refresh)}
              onUpdateNoteWithAgent={(workspaceId, instructions) =>
                workspaceState.queueWorkspaceNoteUpdate(workspaceId, instructions)}
              onInputActivity={(workspaceId, timestamp) => workspaceState.recordWorkspaceInput(workspaceId, timestamp)}
              onOutputActivity={(workspaceId, active, timestamp) => workspaceState.recordWorkspaceOutput(workspaceId, active, timestamp, terminalIsObserved(workspaceId))}
              onTerminalPresentationChange={setTerminalPresentation}
              {mobilePanel}
              onMobilePanelChange={setMobilePanel}
              {repositoryPanelOpen}
              onRepositoryPanelOpenChange={setRepositoryPanelOpen}
              {repositoryTab}
              onRepositoryTabChange={setRepositoryTab}
              statusPlugins={connection.statusPlugins}
            />
          {/key}
        {:else if workspaceState.requestedWorkspaceId && workspaceState.workspacesLoaded}
          <section class="unavailable-sheet" aria-labelledby="missing-workspace-title">
            <div class="unavailable-body">
              <span class="unavailable-icon" aria-hidden="true"><CircleHelp size={22} strokeWidth={1.7} /></span>
              <h2 id="missing-workspace-title">Workspace not found</h2>
              <p>This workspace is no longer registered on this Vampire server.</p>
              <Button variant="secondary" onclick={openWorkspaceNavigator}>Open workspaces</Button>
            </div>
          </section>
        {:else}
          <section class="empty-workbench" aria-labelledby="empty-workbench-title">
            <span class="empty-workbench__prompt" aria-hidden="true"
              ><SquareTerminal size={26} strokeWidth={1.5} /></span
            >
            <h2 id="empty-workbench-title">Select a workspace</h2>
            <p>Choose a workspace from the sidebar or start a new one.</p>
            <p class="empty-workbench__shortcut">
              <Keyboard size={14} strokeWidth={1.7} aria-hidden="true" /> {workspaceShortcutModifier}1–0 · Alt+1–0
            </p>
          </section>
        {/if}

        {#if workspaceSettingsOpen && workspaceState.activeWorkspace}
          <WorkspaceSettings
            workspace={workspaceState.activeWorkspace}
            profiles={workspaceState.launchProfiles}
            onClose={() => workspaceSettingsOpen = false}
            onSave={(settings) => workspaceState.updateWorkspaceStartup(
						workspaceState.activeWorkspace!.id,
						settings.launchProfiles,
						settings.startupProfileId
					)}
          />
        {/if}

        {#if workspaceAutomationsWorkspace}
          <WorkspaceAutomationsDialog
            workspace={workspaceState.workspaces.find((candidate) => candidate.id === workspaceAutomationsWorkspace?.id) ?? workspaceAutomationsWorkspace}
            close={() => workspaceAutomationsWorkspace = undefined}
          />
        {/if}

        {#if worktreeSourceWorkspace}
          <NewWorktreeDialog
            source={worktreeSourceWorkspace}
            close={() => worktreeSourceWorkspace = undefined}
            onCreate={createIsolatedWorkspace}
          />
        {/if}

        {#if workspaceAliasWorkspace}
          <WorkspaceAliasDialog
            workspace={workspaceState.workspaces.find((candidate) => candidate.id === workspaceAliasWorkspace?.id) ?? workspaceAliasWorkspace}
            close={() => workspaceAliasWorkspace = undefined}
            onSave={saveWorkspaceAlias}
          />
        {/if}
      </div>
    </div>
  {/if}
</main>

<style>
main {
  width: 100%;
  min-height: 100dvh;
}
.app-shell {
  min-width: 0;
  min-height: 100dvh;
}
.dashboard {
  min-width: 0;
  min-height: 100dvh;
  padding: max(1rem, env(safe-area-inset-top)) 1rem max(1rem, env(safe-area-inset-bottom));
}
.error {
  margin: 0;
  color: var(--color-danger);
  font-size: var(--text-label);
  line-height: var(--leading-ui);
}
.loading-state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.7rem;
  min-height: 100dvh;
  color: var(--color-text-secondary);
}
.unavailable-sheet {
  position: fixed;
  z-index: 20;
  inset: 0;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  overflow: hidden;
  background: var(--color-terminal-background);
  color: var(--color-text);
}
.unavailable-body {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  width: min(100%, 32rem);
  min-height: 0;
  margin: 0 auto;
  padding: 2rem 1.25rem max(2rem, env(safe-area-inset-bottom));
}
.unavailable-icon {
  display: grid;
  place-items: center;
  width: 3rem;
  height: 3rem;
  margin-bottom: 1.25rem;
  border: 1px solid var(--color-border);
  border-radius: 0.8rem;
  background: var(--color-surface);
  color: var(--color-accent);
}
.unavailable-body h2 {
  margin: 0.3rem 0 0;
  font-size: var(--text-display);
  font-weight: var(--weight-strong);
  line-height: var(--leading-tight);
}
.unavailable-body > p:not(.section-label):not(.error) {
  margin: 0.75rem 0 1rem;
  overflow-wrap: anywhere;
  color: var(--color-text-secondary);
  font-size: var(--text-body);
  line-height: var(--leading-body);
}
.unavailable-body code {
  display: block;
  width: 100%;
  overflow: hidden;
  margin-bottom: 1.25rem;
  padding: 0.75rem;
  border: 1px solid var(--color-border-subtle);
  border-radius: 0.55rem;
  background: var(--color-panel);
  color: var(--color-text-secondary);
  font-size: var(--text-caption);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.unavailable-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.65rem;
  width: 100%;
}
:global(.unavailable-actions > .vampire-button) {
  flex: 1 1 10rem;
}
.unavailable-reopen-control {
  display: flex;
  flex: 1 1 10rem;
  min-width: 0;
  overflow: hidden;
  border-radius: var(--radius-sm);
  background: var(--color-accent);
}
:global(.unavailable-reopen-primary) {
  flex: 1 1 auto;
  min-width: 0;
  border-radius: 0;
}
:global(.unavailable-reopen-menu-trigger) {
  display: grid;
  flex: 0 0 var(--control-height-lg);
  place-items: center;
  width: var(--control-height-lg);
  min-height: var(--control-height-lg);
  padding: 0;
  border: 0;
  border-left: 1px solid color-mix(in srgb, var(--color-accent-ink) 24%, transparent);
  background: transparent;
  color: var(--color-accent-ink);
  cursor: pointer;
}
:global(.unavailable-reopen-menu-trigger[data-state="open"]) {
  background: color-mix(in srgb, var(--color-accent-ink) 12%, transparent);
}
@media (hover: hover) {
  :global(.unavailable-reopen-menu-trigger:hover) {
    background: color-mix(in srgb, var(--color-accent-ink) 12%, transparent);
  }
}
.unavailable-reopen-menu {
  display: grid;
  max-height: min(24rem, calc(100vh - 2rem));
  gap: 0.35rem;
  overflow-y: auto;
  padding: 0.45rem 0.55rem 0.55rem;
}
.unavailable-reopen-menu > strong {
  color: var(--color-text);
  font-size: var(--text-label);
  font-weight: var(--weight-medium);
}
.unavailable-reopen-menu > p {
  margin: 0 0 0.1rem;
  color: var(--color-text-secondary);
  font-size: var(--text-caption);
  line-height: var(--leading-ui);
}
:global(.unavailable-reopen-option) {
  align-items: flex-start;
  min-height: 2.5rem;
  padding-block: 0.35rem;
}
.unavailable-reopen-copy {
  display: grid;
  min-width: 0;
  gap: 0.08rem;
}
.unavailable-reopen-copy strong {
  overflow: hidden;
  color: inherit;
  font-size: var(--text-label);
  font-weight: var(--weight-medium);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.unavailable-reopen-copy span {
  overflow: hidden;
  color: var(--color-text-tertiary);
  font-family: var(--font-mono);
  font-size: var(--text-micro);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.unavailable-body .error {
  margin-top: 0.9rem;
}
.empty-workbench {
  display: none;
}
@media (min-width: 64rem) {
  main {
    height: 100dvh;
    overflow: hidden;
  }
  .app-shell {
    height: 100%;
    min-height: 0;
  }
  .dashboard {
    display: grid;
    grid-template-columns: 20rem minmax(0, 1fr);
    align-items: stretch;
    gap: 0;
    height: 100%;
    min-height: 0;
    padding: 0;
  }
  .empty-workbench {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-width: 0;
    background: var(--color-terminal-background);
    color: var(--color-text-tertiary);
  }
  .empty-workbench__prompt {
    margin-bottom: 0.9rem;
    color: var(--color-text-disabled);
  }
  .empty-workbench h2 {
    margin: 0;
    color: var(--color-text-tertiary);
    font-size: var(--text-title);
    font-weight: var(--weight-medium);
    line-height: var(--leading-tight);
  }
  .empty-workbench p {
    margin: 0.45rem 0 0;
    font-size: var(--text-caption);
  }
  .empty-workbench .empty-workbench__shortcut {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin-top: 0.9rem;
    color: var(--color-text-disabled);
    font-family: var(--font-mono);
    font-size: var(--text-caption);
  }
  .unavailable-sheet {
    position: relative;
    z-index: 1;
    inset: auto;
    height: 100%;
    min-height: 0;
    border: 0;
    border-radius: 0;
  }
}
</style>
