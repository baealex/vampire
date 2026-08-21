<script lang="ts">
import { DropdownMenu } from 'bits-ui';
import { dev } from '$app/environment';
import { pushState } from '$app/navigation';
import { onMount } from 'svelte';
import ChevronDown from '@lucide/svelte/icons/chevron-down';
import CircleHelp from '@lucide/svelte/icons/circle-help';
import Keyboard from '@lucide/svelte/icons/keyboard';
import SquarePlay from '@lucide/svelte/icons/square-play';
import SquareTerminal from '@lucide/svelte/icons/square-terminal';
import LoginScreen from '$lib/LoginScreen.svelte';
import TmuxSetupScreen from '$lib/TmuxSetupScreen.svelte';
import DropdownMenuShell from '$lib/ui/DropdownMenuShell.svelte';
import Spinner from '$lib/ui/Spinner.svelte';
import { isUiOverlayOpen } from '$lib/ui/overlay';
import { WorkspaceConnectionState } from '$lib/app/workspace-connection-state.svelte';
import WorkspaceWorkbench from '$lib/repository/WorkspaceWorkbench.svelte';
import type { RepositoryTab } from '$lib/repository/types';
import NewWorktreeDialog from '$lib/session/NewWorktreeDialog.svelte';
import SessionNavigator from '$lib/session/SessionNavigator.svelte';
import WorkspaceAliasDialog from '$lib/session/WorkspaceAliasDialog.svelte';
import WorkspaceAutomationsDialog from '$lib/session/WorkspaceAutomationsDialog.svelte';
import WorkspaceSettings from '$lib/session/WorkspaceSettings.svelte';
import { SessionWorkspaceState } from '$lib/session/workspace-state.svelte';
import type { ManagedSession, MobilePanel } from '$lib/session/types';
import { isWorktreeWorkspace, workspaceName, workspaceRepositoryName } from '$lib/session/view';
import { REPOSITORY_SPLIT_MEDIA_QUERY } from '$lib/ui/layout';
import TerminalHeader from '$lib/terminal/TerminalHeader.svelte';

let { initialSessionId = undefined }: { initialSessionId?: string } = $props();

let mobilePanel = $state<MobilePanel | undefined>(undefined);
let repositoryPanelOpen = $state(false);
let repositoryTab = $state<RepositoryTab>('files');
let workspaceSettingsOpen = $state(false);
let reopenWithOpen = $state(false);
let workspaceAliasSession = $state<ManagedSession>();
let workspaceAutomationsSession = $state<ManagedSession>();
let worktreeSourceSession = $state<ManagedSession>();
let presentedTerminalSessionId = $state<string | undefined>(undefined);
let sessionShortcutModifier = $state('Ctrl');
let previewTmuxUnavailable = $state(false);
let useMetaSessionShortcuts = false;
const REPOSITORY_TAB_KEY = 'vampire:repository-tab';

const connection = new WorkspaceConnectionState();
const tmuxStatus = $derived(
  connection.tmuxStatus && previewTmuxUnavailable
    ? { ...connection.tmuxStatus, available: false, version: null }
    : connection.tmuxStatus
);
const workspace: SessionWorkspaceState = new SessionWorkspaceState({
  navigate: (path) => pushState(path, {}),
  onUnauthorized: () => connection.markUnauthenticated(),
  isSessionObserved: (sessionId) => terminalIsObserved(sessionId),
});
function terminalIsObserved(sessionId: string): boolean {
  return (
    workspace.requestedSessionId === sessionId &&
    presentedTerminalSessionId === sessionId &&
    document.visibilityState === 'visible' &&
    mobilePanel === undefined &&
    !workspaceSettingsOpen &&
    !workspaceAliasSession &&
    !worktreeSourceSession &&
    !workspaceAutomationsSession
  );
}

function setTerminalPresentation(sessionId: string, presented: boolean) {
  if (presented) {
    presentedTerminalSessionId = sessionId;
    markActiveSessionObserved();
    return;
  }
  if (presentedTerminalSessionId !== sessionId) return;
  if (terminalIsObserved(sessionId)) workspace.markSessionObserved(sessionId);
  presentedTerminalSessionId = undefined;
}

function markActiveSessionObserved() {
  if (workspace.requestedSessionId && terminalIsObserved(workspace.requestedSessionId)) {
    workspace.markSessionObserved(workspace.requestedSessionId);
  }
}

function setMobilePanel(panel: MobilePanel | undefined) {
  if (mobilePanel === undefined && panel !== undefined) markActiveSessionObserved();
  mobilePanel = panel;
  if (panel === undefined) markActiveSessionObserved();
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
  workspace.reset();
  workspaceSettingsOpen = false;
  reopenWithOpen = false;
  workspaceAliasSession = undefined;
  worktreeSourceSession = undefined;
  workspaceAutomationsSession = undefined;
  repositoryPanelOpen = false;
  mobilePanel = 'sessions';
  pushState('/', {});
}

function openSession(session: ManagedSession) {
  workspaceSettingsOpen = false;
  reopenWithOpen = false;
  workspaceAliasSession = undefined;
  worktreeSourceSession = undefined;
  workspaceAutomationsSession = undefined;
  workspace.openSession(session);
  restorePanelAfterWorkspaceChange();
}

function openStartupProfile(session: ManagedSession) {
  workspaceAliasSession = undefined;
  worktreeSourceSession = undefined;
  workspaceAutomationsSession = undefined;
  if (workspace.requestedSessionId !== session.id) {
    workspace.openSession(session);
    restorePanelAfterWorkspaceChange();
  }
  repositoryPanelOpen = false;
  mobilePanel = undefined;
  workspaceSettingsOpen = true;
}

function openWorkspaceAlias(session: ManagedSession) {
  workspaceSettingsOpen = false;
  worktreeSourceSession = undefined;
  workspaceAutomationsSession = undefined;
  workspaceAliasSession = session;
}

function openWorkspaceAutomations(session: ManagedSession) {
  workspaceSettingsOpen = false;
  workspaceAliasSession = undefined;
  worktreeSourceSession = undefined;
  workspaceAutomationsSession = session;
}

async function saveWorkspaceAlias(alias: string): Promise<{ ok: boolean; error?: string }> {
  const session = workspaceAliasSession;
  if (!session) return { ok: false, error: 'Workspace is no longer available.' };
  return workspace.updateWorkspaceAlias(session.id, alias);
}

function openNewWorktree(session: ManagedSession) {
  workspaceSettingsOpen = false;
  workspaceAliasSession = undefined;
  workspaceAutomationsSession = undefined;
  worktreeSourceSession = session;
}

async function createIsolatedWorkspace(name: string): Promise<{ ok: boolean; error?: string }> {
  const source = worktreeSourceSession;
  if (!source) return { ok: false, error: 'Source workspace is no longer available.' };
  const result = await workspace.createIsolatedWorkspace(source.id, name, tmuxStatus?.available);
  if (result.ok) {
    worktreeSourceSession = undefined;
    restorePanelAfterWorkspaceChange();
  }
  return result;
}

async function createSession() {
  if (await workspace.createSession(tmuxStatus?.available)) restorePanelAfterWorkspaceChange();
}

function clearActiveSession() {
  workspaceSettingsOpen = false;
  reopenWithOpen = false;
  workspaceAliasSession = undefined;
  worktreeSourceSession = undefined;
  workspaceAutomationsSession = undefined;
  mobilePanel = 'sessions';
  workspace.clearActiveSession();
}

function openSessionNavigator() {
  mobilePanel = 'sessions';
}

function closeSessionNavigator() {
  if (workspace.hasOpenSession) restorePanelAfterWorkspaceChange();
}

function syncSessionFromLocation(pathname = location.pathname) {
  workspace.syncLocation(pathname);
  if (workspace.requestedSessionId) restorePanelAfterWorkspaceChange();
  else mobilePanel = 'sessions';
  markActiveSessionObserved();
}

async function restartSession(
  session: ManagedSession,
  launchProfileId?: string | null
): Promise<{ ok: boolean; error?: string }> {
  if (!(await workspace.restartSession(session, launchProfileId))) {
    return { ok: false, error: workspace.sessionActionError };
  }
  const restartedSession = workspace.sessions.find((candidate) => candidate.id === session.id);
  if (restartedSession) openSession(restartedSession);
  return { ok: true };
}

async function closeSession(session: ManagedSession): Promise<{ ok: boolean; error?: string }> {
  const wasActive = workspace.requestedSessionId === session.id;
  if (!(await workspace.closeSession(session))) return { ok: false, error: workspace.sessionActionError };
  if (workspaceAutomationsSession?.id === session.id) workspaceAutomationsSession = undefined;
  if (wasActive) mobilePanel = 'sessions';
  return { ok: true };
}

async function removeSession(session: ManagedSession): Promise<{ ok: boolean; error?: string }> {
  const wasActive = workspace.requestedSessionId === session.id;
  if (!(await workspace.removeSession(session))) return { ok: false, error: workspace.sessionActionError };
  if (workspaceAutomationsSession?.id === session.id) workspaceAutomationsSession = undefined;
  if (wasActive) mobilePanel = 'sessions';
  return { ok: true };
}

function handleSessionShortcut(event: KeyboardEvent) {
  const digitMatch = /^(?:Digit|Numpad)(\d)$/.exec(event.code);
  if (event.defaultPrevented || event.repeat || event.isComposing || event.shiftKey || !digitMatch) return;
  if (isUiOverlayOpen()) return;
  const primaryModifier = useMetaSessionShortcuts ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  const fallbackModifier = event.altKey && !event.metaKey && !event.ctrlKey;
  if (!primaryModifier && !fallbackModifier) return;

  const digit = digitMatch[1];
  const index = digit === '0' ? 9 : Number(digit) - 1;
  const targetSession = workspace.shortcutSessions[index];
  if (!targetSession) return;
  event.preventDefault();
  event.stopPropagation();
  openSession(targetSession);
}

function handleOverlayKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return;
  if (isUiOverlayOpen()) return;
  if (workspaceSettingsOpen) {
    event.preventDefault();
    workspaceSettingsOpen = false;
    return;
  }
  if (mobilePanel === 'sessions' && workspace.hasOpenSession) {
    event.preventDefault();
    closeSessionNavigator();
  }
}

onMount(() => {
  const initialSessionPath = initialSessionId ? `/sessions/${encodeURIComponent(initialSessionId)}` : '/';
  syncSessionFromLocation(location.pathname || initialSessionPath);
  previewTmuxUnavailable = dev && new URLSearchParams(location.search).get('preview') === 'tmux';
  useMetaSessionShortcuts = /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
  sessionShortcutModifier = useMetaSessionShortcuts ? '⌘' : 'Ctrl+';
  workspace.restoreBrowserPreferences(window.localStorage);
  const savedRepositoryTab = window.localStorage.getItem(REPOSITORY_TAB_KEY);
  if (savedRepositoryTab === 'changes' || savedRepositoryTab === 'files') repositoryTab = savedRepositoryTab;
  const stopConnection = connection.start({
    refreshSessions: (options) => workspace.refresh(options),
    onVisible: markActiveSessionObserved,
    onSessionEvent: (event) => {
      if (event.type === 'sessions-snapshot') {
        workspace.applySessionSnapshot(event.sessions);
        if (event.preferences !== undefined) workspace.applyWorkspacePreferences(event.preferences);
        if (event.launchProfiles !== undefined) workspace.applyLaunchProfiles(event.launchProfiles);
        if (event.preferences !== undefined) {
          workspace.applyWorkspacePreferences(event.preferences, { initialSnapshot: true });
        }
        if (event.launchProfiles !== undefined) workspace.applyLaunchProfiles(event.launchProfiles);
      } else if (event.type === 'session-added') workspace.applySessionAdded(event.session);
      else if (event.type === 'session-updated') workspace.applySessionUpdated(event.id, event.changes);
      else if (event.type === 'session-removed') workspace.applySessionRemoved(event.id);
      else if (event.type === 'workspace-preferences-updated') workspace.applyWorkspacePreferences(event.preferences);
      else workspace.applyLaunchProfiles(event.launchProfiles);
    },
  });
  const handlePopState = () => syncSessionFromLocation();
  const handleVisibilityChange = () => {
    const requestedSessionId = workspace.requestedSessionId;
    if (
      document.hidden &&
      requestedSessionId &&
      requestedSessionId === presentedTerminalSessionId &&
      mobilePanel === undefined
    ) {
      workspace.markSessionObserved(requestedSessionId);
    } else if (!document.hidden) {
      markActiveSessionObserved();
    }
  };
  window.addEventListener('popstate', handlePopState);
  window.addEventListener('keydown', handleSessionShortcut, { capture: true });
  window.addEventListener('keydown', handleOverlayKeydown, { capture: true });
  document.addEventListener('visibilitychange', handleVisibilityChange);

  return () => {
    stopConnection();
    workspace.dispose();
    window.removeEventListener('popstate', handlePopState);
    window.removeEventListener('keydown', handleSessionShortcut, { capture: true });
    window.removeEventListener('keydown', handleOverlayKeydown, { capture: true });
    document.removeEventListener('visibilitychange', handleVisibilityChange);
  };
});
</script>

<svelte:head>
  <meta name="description" content="A self-hosted browser workspace for persistent tmux sessions.">
</svelte:head>

<main class:terminal-open={workspace.hasOpenSession}>
  {#if connection.checking}
    <section class="loading-state" aria-live="polite">
      <Spinner />
      Connecting…
    </section>
  {:else if tmuxStatus?.available === false}
    <TmuxSetupScreen status={tmuxStatus} />
  {:else if connection.authenticationRequired && !connection.authenticated}
    <LoginScreen
      token={connection.token}
      error={connection.loginError}
      onTokenChange={(token) => connection.token = token}
      onSubmit={() => void unlock()}
    />
  {:else}
    <div class="app-shell">
      <div class="dashboard" class:terminal-open={workspace.hasOpenSession}>
        <SessionNavigator
          sessions={workspace.sessions}
          displayedSessions={workspace.displayedSessions}
          selectedSessionId={workspace.activeSession?.id}
          activityRecords={workspace.activityRecords}
          hasOpenSession={workspace.hasOpenSession}
          mobileOpen={mobilePanel === 'sessions'}
          errorMessage={workspace.errorMessage || connection.errorMessage}
          sessionOrderMode={workspace.sessionOrderMode}
          workspacePreferencesError={workspace.workspacePreferencesError}
          bind:newSessionOpen={workspace.newSessionOpen}
          bind:cwd={workspace.cwd}
          starting={workspace.starting}
          startError={workspace.startError}
          tmuxAvailable={tmuxStatus?.available}
          onClose={closeSessionNavigator}
          onOrderModeChange={(mode) => workspace.setSessionOrderMode(mode)}
          onReorder={(draggedId, targetId, position) => workspace.reorderSession(draggedId, targetId, position)}
          onOpen={openSession}
          onSettings={openStartupProfile}
          onAlias={openWorkspaceAlias}
          onNewWorktree={openNewWorktree}
          onAutomations={openWorkspaceAutomations}
          sessionAction={workspace.sessionAction}
          onCloseSession={closeSession}
          onRemoveSession={removeSession}
          onCreate={() => void createSession()}
        />

        {#if workspace.activeSession?.state === 'missing'}
          <section class="unavailable-sheet" aria-labelledby="ended-session-title">
            <TerminalHeader
              projectName={workspaceName(workspace.activeSession)}
              cwd={workspace.activeSession.cwd}
              isWorktree={isWorktreeWorkspace(workspace.activeSession)}
              repositoryName={workspaceRepositoryName(workspace.activeSession)}
              worktreeBranch={workspace.activeSession.worktreeBranch}
              hasNote={Boolean(workspace.activeSession.notePreview)}
              noteOpen={false}
              statusLabel="Ended"
              showTools={false}
              close={openSessionNavigator}
              repositoryOpen={true}
              isGitRepository={workspace.activeSession.isGitRepository}
              workspaceAvailable={workspace.activeSession.workspaceAvailable !== false}
              changeCount={0}
              worktreeCount={0}
              backgroundOpen={false}
              backgroundCount={0}
              backgroundPanelId={`ended-background-${workspace.activeSession.id}`}
              backgroundTriggerId={`ended-background-trigger-${workspace.activeSession.id}`}
              toggleRepository={() => undefined}
              toggleNote={() => undefined}
              toggleBackground={() => undefined}
            />
            <div class="unavailable-body">
              <span class="unavailable-icon" aria-hidden="true"><SquareTerminal size={22} strokeWidth={1.7} /></span>
              <p class="section-label">
                {workspace.activeSession.workspaceAvailable === false ? 'working copy unavailable' : 'tmux session unavailable'}
              </p>
              <h2 id="ended-session-title">
                {workspace.activeSession.workspaceAvailable === false ? 'This working copy was removed' : 'This shell has ended'}
              </h2>
              <p>
                {workspace.activeSession.workspaceAvailable === false
							? 'The terminal has ended and its working directory no longer exists. Removing this entry does not delete the Git branch.'
							: 'The process is no longer running. You can open a fresh shell in the same project or remove this workspace from the list.'}
              </p>
              <code>{workspace.activeSession.cwd}</code>
              <div class="unavailable-actions">
                {#if workspace.activeSession.workspaceAvailable !== false}
                  <div class="unavailable-reopen-control">
                    <button
                      class="primary-button unavailable-reopen-primary"
                      onclick={() => void restartSession(workspace.activeSession!)}
                      disabled={Boolean(workspace.sessionAction)}
                    >
                      {workspace.sessionAction === 'restart' ? 'Reopening…' : 'Reopen shell'}
                    </button>
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
                          <DropdownMenu.Item
                            class="vampire-menu-item unavailable-reopen-option"
                            disabled={Boolean(workspace.sessionAction)}
                            onSelect={() => void restartSession(workspace.activeSession!, null)}
                          >
                            <SquareTerminal size={16} strokeWidth={1.8} aria-hidden="true" />
                            <span class="unavailable-reopen-copy"><strong>Blank terminal</strong></span>
                          </DropdownMenu.Item>
                          {#each workspace.launchProfiles as profile (profile.id)}
                            <DropdownMenu.Item
                              class="vampire-menu-item unavailable-reopen-option"
                              disabled={Boolean(workspace.sessionAction)}
                              onSelect={() => void restartSession(workspace.activeSession!, profile.id)}
                            >
                              <SquarePlay size={16} strokeWidth={1.8} aria-hidden="true" />
                              <span class="unavailable-reopen-copy">
                                <strong>{profile.name}</strong>
                                <span>{profile.command}</span>
                              </span>
                            </DropdownMenu.Item>
                          {/each}
                        </div>
                      {/snippet}
                    </DropdownMenuShell>
                  </div>
                {/if}
                <button
                  class="remove-button"
                  onclick={() => void removeSession(workspace.activeSession!)}
                  disabled={Boolean(workspace.sessionAction)}
                >
                  {workspace.sessionAction === 'remove' ? 'Removing…' : 'Remove workspace'}
                </button>
              </div>
              {#if workspace.sessionActionError}
                <p class="error" role="alert">{workspace.sessionActionError}</p>
              {/if}
            </div>
          </section>
        {:else if workspace.activeSession}
          {#key workspace.activeSession.id}
            <WorkspaceWorkbench
              session={workspace.activeSession}
              onStartBackground={(command) => workspace.startBackgroundProcess(workspace.activeSession!.id, command)}
              onStopBackground={(process) => workspace.stopBackgroundProcess(workspace.activeSession!.id, process.id)}
              onLoadBackgroundOutput={(processId) => workspace.loadBackgroundOutput(workspace.activeSession!.id, processId)}
              onFavoriteBackground={(command) => workspace.favoriteBackgroundCommand(workspace.activeSession!.id, command)}
              onRemoveBackgroundFavorite={(command) => workspace.removeBackgroundCommandFavorite(workspace.activeSession!.id, command)}
              startingBackground={workspace.startingBackgroundSessionId === workspace.activeSession.id}
              stoppingBackgroundProcessId={workspace.stoppingBackgroundProcessId}
              updatingFavoriteCommand={workspace.updatingFavoriteCommand}
              backgroundActionError={workspace.backgroundActionErrorSessionId === workspace.activeSession.id ? workspace.backgroundActionError : ''}
              onLogout={connection.authenticationRequired ? () => void logout() : undefined}
              close={openSessionNavigator}
              onUpdateNote={(sessionId, note) => workspace.updateSessionNote(sessionId, note)}
              onLoadNote={(sessionId, refresh) => workspace.loadSessionNote(sessionId, refresh)}
              onSummarizeNote={(sessionId) => workspace.queueSessionNoteSummary(sessionId)}
              onInputActivity={(sessionId, timestamp) => workspace.recordSessionInput(sessionId, timestamp)}
              onOutputActivity={(sessionId, active, timestamp) => workspace.recordSessionOutput(sessionId, active, timestamp, terminalIsObserved(sessionId))}
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
        {:else if workspace.requestedSessionId && workspace.sessionsLoaded}
          <section class="unavailable-sheet" aria-labelledby="missing-session-title">
            <div class="unavailable-body">
              <span class="unavailable-icon" aria-hidden="true"><CircleHelp size={22} strokeWidth={1.7} /></span>
              <h2 id="missing-session-title">Workspace not found</h2>
              <p>This workspace is no longer registered on this Vampire server.</p>
              <button class="secondary-button" onclick={openSessionNavigator}>Open workspaces</button>
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
              <Keyboard size={14} strokeWidth={1.7} aria-hidden="true" /> {sessionShortcutModifier}1–0 · Alt+1–0
            </p>
          </section>
        {/if}

        {#if workspaceSettingsOpen && workspace.activeSession}
          <WorkspaceSettings
            session={workspace.activeSession}
            profiles={workspace.launchProfiles}
            onClose={() => workspaceSettingsOpen = false}
            onSave={(settings) => workspace.updateWorkspaceStartup(
						workspace.activeSession!.id,
						settings.launchProfiles,
						settings.startupProfileId
					)}
          />
        {/if}

        {#if workspaceAutomationsSession}
          <WorkspaceAutomationsDialog
            session={workspace.sessions.find((candidate) => candidate.id === workspaceAutomationsSession?.id) ?? workspaceAutomationsSession}
            close={() => workspaceAutomationsSession = undefined}
          />
        {/if}

        {#if worktreeSourceSession}
          <NewWorktreeDialog
            source={worktreeSourceSession}
            close={() => worktreeSourceSession = undefined}
            onCreate={createIsolatedWorkspace}
          />
        {/if}

        {#if workspaceAliasSession}
          <WorkspaceAliasDialog
            session={workspace.sessions.find((session) => session.id === workspaceAliasSession?.id) ?? workspaceAliasSession}
            close={() => workspaceAliasSession = undefined}
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
.primary-button,
.secondary-button {
  min-height: var(--control-height-lg);
  padding: 0 1rem;
  border: 0;
  border-radius: var(--radius-sm);
  font-size: var(--text-label);
  font-weight: var(--weight-medium);
  cursor: pointer;
}
.primary-button {
  background: var(--color-accent);
  color: var(--color-accent-ink);
}
@media (hover: hover) {
  .primary-button:hover {
    background: var(--color-accent-hover);
  }
}
.primary-button:disabled {
  cursor: wait;
  opacity: 0.65;
}
.secondary-button {
  background: var(--color-surface-raised);
  color: var(--color-text);
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
.unavailable-actions > button {
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
.unavailable-reopen-primary {
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
.remove-button {
  min-height: var(--control-height-lg);
  padding: 0 1rem;
  border: 1px solid var(--color-danger-border);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-danger-text);
  font-size: var(--text-label);
  font-weight: var(--weight-medium);
  cursor: pointer;
}
@media (hover: hover) {
  .remove-button:hover {
    background: var(--color-danger-surface-hover);
  }
}
.remove-button:disabled {
  cursor: wait;
  opacity: 0.6;
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
