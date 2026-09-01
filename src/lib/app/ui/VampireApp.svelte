<script lang="ts">
import { dev } from '$app/environment';
import { beforeNavigate, pushState } from '$app/navigation';
import { onMount, tick } from 'svelte';
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
import ConfirmDialog from '~/lib/shared/ui/ConfirmDialog.svelte';
import Spinner from '~/lib/shared/ui/Spinner.svelte';
import { isUiOverlayOpen } from '~/lib/shared/ui/overlay';
import { WorkspaceConnectionState } from '~/lib/app/model/workspace-connection-state.svelte';
import WorkspaceWorkbench from '~/lib/widgets/workspace-workbench/ui/WorkspaceWorkbench.svelte';
import type { RepositoryTab } from '~/lib/shared/contracts/repository';
import NewWorktreeDialog from '~/lib/features/workspace/ui/NewWorktreeDialog.svelte';
import WorkspaceNavigator from '~/lib/features/workspace/ui/WorkspaceNavigator.svelte';
import WorkspaceAliasDialog from '~/lib/features/workspace/ui/WorkspaceAliasDialog.svelte';
import WorkspaceAutomationsPage from '~/lib/widgets/workspace-workbench/ui/WorkspaceAutomationsPage.svelte';
import AppSidebarActions from './AppSidebarActions.svelte';
import StatusPluginSettings from '~/lib/features/status/ui/StatusPluginSettings.svelte';
import WorkspaceSettings from '~/lib/features/workspace/ui/WorkspaceSettings.svelte';
import { WorkspaceState } from '~/lib/features/workspace/model/workspace-state.svelte';
import type { ManagedWorkspace, MobilePanel } from '~/lib/shared/contracts/workspace';
import { isWorktreeWorkspace, workspaceName } from '~/lib/features/workspace/model/workspace-view';
import { REPOSITORY_SPLIT_MEDIA_QUERY } from '~/lib/shared/ui/layout';
import TerminalHeader from '~/lib/features/terminal/ui/TerminalHeader.svelte';
import AppAutomationsPage from './AppAutomationsPage.svelte';
import AppSettingsPage from './AppSettingsPage.svelte';
import ListeningPortsDialog from '~/lib/features/system/ui/ListeningPortsDialog.svelte';

type ManagementView = 'automations' | 'server-automations' | 'settings' | 'widgets';

let {
  initialWorkspaceId = undefined,
}: {
  initialWorkspaceId?: string;
} = $props();

let mobilePanel = $state<MobilePanel | undefined>(undefined);
let repositoryPanelOpen = $state(false);
let repositoryTab = $state<RepositoryTab>('files');
let workspaceSettingsOpen = $state(false);
let reopenWithOpen = $state(false);
let workspaceAliasWorkspace = $state<ManagedWorkspace>();
let managementView = $state<ManagementView>();
let automationEditId = $state<string>();
let managementOpenedFromApp = false;
let managementBusy = $state(false);
let managementDirty = $state(false);
let managementClosePrompt = $state(false);
let listeningPortsOpen = $state(false);
let restoringManagementHistory: 'busy' | 'dirty' | undefined;
let restoringWorkspaceHistory = false;
let syncedHistoryIndex: number | undefined;
let pendingManagementAction: (() => void | Promise<void>) | undefined;
let workspaceNavigationGuard: (() => Promise<boolean>) | undefined;
let worktreeSourceWorkspace = $state<ManagedWorkspace>();
let presentedTerminalWorkspaceId = $state<string | undefined>(undefined);
let workspaceShortcutModifier = $state('Ctrl');
let previewTmuxUnavailable = $state(false);
let useMetaWorkspaceShortcuts = false;
const REPOSITORY_TAB_KEY = 'vampire:repository-tab';

function historyIndex(state: unknown = history.state): number | undefined {
  if (!state || typeof state !== 'object') return undefined;
  const index = (state as Record<string, unknown>)['sveltekit:history'];
  return typeof index === 'number' ? index : undefined;
}

function pushApplicationState(path: string) {
  pushState(path, {});
  syncedHistoryIndex = historyIndex();
}

beforeNavigate(({ cancel }) => {
  if (!managementView) return;
  if (managementBusy) {
    cancel();
    return;
  }
  if (managementDirty) {
    cancel();
    managementClosePrompt = true;
  }
});

const connection = new WorkspaceConnectionState();
const tmuxStatus = $derived(
  connection.tmuxStatus && previewTmuxUnavailable
    ? { ...connection.tmuxStatus, available: false, version: null }
    : connection.tmuxStatus
);
const workspaceState: WorkspaceState = new WorkspaceState({
  navigate: pushApplicationState,
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
    !managementView
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
  managementView = undefined;
  listeningPortsOpen = false;
  managementOpenedFromApp = false;
  repositoryPanelOpen = false;
  mobilePanel = 'workspaces';
  pushApplicationState('/');
}

function guardManagementTransition(action: () => void | Promise<void>): boolean {
  if (!managementView) return false;
  if (managementBusy) return true;
  if (managementDirty) {
    pendingManagementAction = action;
    managementClosePrompt = true;
    return true;
  }
  managementView = undefined;
  managementOpenedFromApp = false;
  managementBusy = false;
  managementDirty = false;
  return false;
}

async function openWorkspace(managedWorkspace: ManagedWorkspace) {
  if (guardManagementTransition(() => openWorkspace(managedWorkspace))) return;
  if (workspaceNavigationGuard && !(await workspaceNavigationGuard())) return;
  const alreadySelected = workspaceState.requestedWorkspaceId === managedWorkspace.id;
  workspaceSettingsOpen = false;
  reopenWithOpen = false;
  workspaceAliasWorkspace = undefined;
  worktreeSourceWorkspace = undefined;
  managementView = undefined;
  managementOpenedFromApp = false;
  if (alreadySelected) pushApplicationState(`/workspaces/${encodeURIComponent(managedWorkspace.id)}`);
  else workspaceState.openWorkspace(managedWorkspace);
  restorePanelAfterWorkspaceChange();
}

async function openStartupProfile(managedWorkspace: ManagedWorkspace) {
  if (guardManagementTransition(() => openStartupProfile(managedWorkspace))) return;
  if (workspaceNavigationGuard && !(await workspaceNavigationGuard())) return;
  workspaceAliasWorkspace = undefined;
  worktreeSourceWorkspace = undefined;
  managementView = undefined;
  if (workspaceState.requestedWorkspaceId !== managedWorkspace.id) {
    workspaceState.openWorkspace(managedWorkspace);
    restorePanelAfterWorkspaceChange();
  }
  repositoryPanelOpen = false;
  mobilePanel = undefined;
  workspaceSettingsOpen = true;
}

function openWorkspaceAlias(managedWorkspace: ManagedWorkspace) {
  if (guardManagementTransition(() => openWorkspaceAlias(managedWorkspace))) return;
  workspaceSettingsOpen = false;
  worktreeSourceWorkspace = undefined;
  workspaceAliasWorkspace = managedWorkspace;
}

async function openWorkspaceAutomations(managedWorkspace: ManagedWorkspace, automationId?: string) {
  if (guardManagementTransition(() => openWorkspaceAutomations(managedWorkspace, automationId))) return;
  if (workspaceNavigationGuard && !(await workspaceNavigationGuard())) return;
  workspaceSettingsOpen = false;
  workspaceAliasWorkspace = undefined;
  worktreeSourceWorkspace = undefined;
  if (workspaceState.requestedWorkspaceId !== managedWorkspace.id) {
    workspaceState.syncLocation(`/workspaces/${encodeURIComponent(managedWorkspace.id)}`);
  }
  managementView = 'automations';
  automationEditId = automationId;
  managementBusy = false;
  managementDirty = false;
  managementOpenedFromApp = true;
  mobilePanel = undefined;
  const editQuery = automationId ? `?edit=${encodeURIComponent(automationId)}` : '';
  pushApplicationState(`/workspaces/${encodeURIComponent(managedWorkspace.id)}/automations${editQuery}`);
}

async function openApplicationSettings() {
  if (guardManagementTransition(() => openApplicationSettings())) return;
  if (workspaceNavigationGuard && !(await workspaceNavigationGuard())) return;
  workspaceSettingsOpen = false;
  workspaceAliasWorkspace = undefined;
  worktreeSourceWorkspace = undefined;
  managementView = 'settings';
  automationEditId = undefined;
  managementBusy = false;
  managementDirty = false;
  managementOpenedFromApp = true;
  mobilePanel = undefined;
  const workspaceId = workspaceState.requestedWorkspaceId;
  pushApplicationState(workspaceId ? '/settings?workspace=' + encodeURIComponent(workspaceId) : '/settings');
}

async function openServerAutomations(workspaceId?: string) {
  if (guardManagementTransition(() => openServerAutomations(workspaceId))) return;
  if (workspaceNavigationGuard && !(await workspaceNavigationGuard())) return;
  workspaceSettingsOpen = false;
  workspaceAliasWorkspace = undefined;
  worktreeSourceWorkspace = undefined;
  managementView = 'server-automations';
  automationEditId = undefined;
  managementBusy = false;
  managementDirty = false;
  managementOpenedFromApp = true;
  mobilePanel = undefined;
  const target = workspaceId ?? workspaceState.requestedWorkspaceId;
  pushApplicationState(
    target ? `/settings/automations?workspace=${encodeURIComponent(target)}` : '/settings/automations'
  );
}

async function openStatusWidgets(workspaceId?: string) {
  if (guardManagementTransition(() => openStatusWidgets(workspaceId))) return;
  if (workspaceNavigationGuard && !(await workspaceNavigationGuard())) return;
  workspaceSettingsOpen = false;
  workspaceAliasWorkspace = undefined;
  worktreeSourceWorkspace = undefined;
  managementView = 'widgets';
  automationEditId = undefined;
  managementBusy = false;
  managementDirty = false;
  managementOpenedFromApp = true;
  mobilePanel = undefined;
  const target = workspaceId ?? workspaceState.requestedWorkspaceId;
  pushApplicationState(target ? `/settings/widgets?workspace=${encodeURIComponent(target)}` : '/settings/widgets');
}

async function restoreManagementTrigger(view: ManagementView) {
  await tick();
  let target =
    view === 'settings'
      ? document.querySelector<HTMLElement>('[aria-label="Open settings"]')
      : document.querySelector<HTMLElement>('[aria-label="Manage status widgets"]');
  if (view === 'automations') {
    const workspaceActions = document.querySelector<HTMLElement>(
      '.workspace-row-shell.selected [aria-label^="Workspace actions for"]'
    );
    const workspaceActionsVisible =
      isRepositorySplitViewport() &&
      workspaceActions &&
      !workspaceActions.closest('[inert]') &&
      getComputedStyle(workspaceActions).visibility !== 'hidden' &&
      getComputedStyle(workspaceActions).display !== 'none';
    target = workspaceActionsVisible
      ? workspaceActions
      : document.querySelector<HTMLElement>('[aria-label="Open workspaces"]');
  } else if (view === 'server-automations') {
    target =
      document.querySelector<HTMLElement>('[aria-label="Manage all automations"]') ??
      document.querySelector<HTMLElement>('[aria-label="Open settings"]');
  }
  if (target) {
    target.dataset.terminalAutofocus = 'preserve';
    target.focus();
  }
}

function finishCloseManagementView() {
  const previousManagementView = managementView;
  const workspaceId = workspaceState.requestedWorkspaceId;
  managementBusy = false;
  managementDirty = false;
  managementClosePrompt = false;
  if (managementOpenedFromApp) {
    history.back();
    return;
  }
  managementView = undefined;
  pushApplicationState(workspaceId ? `/workspaces/${encodeURIComponent(workspaceId)}` : '/');
  if (previousManagementView) void restoreManagementTrigger(previousManagementView);
}

function closeManagementView() {
  if (managementBusy) return;
  if (managementDirty) {
    managementClosePrompt = true;
    return;
  }
  finishCloseManagementView();
}

async function discardManagementChanges() {
  const pendingAction = pendingManagementAction;
  pendingManagementAction = undefined;
  if (pendingAction) {
    managementView = undefined;
    managementOpenedFromApp = false;
    managementBusy = false;
    managementDirty = false;
    managementClosePrompt = false;
    await pendingAction();
    return;
  }
  finishCloseManagementView();
}

function cancelManagementClosePrompt() {
  pendingManagementAction = undefined;
  managementClosePrompt = false;
}

async function saveWorkspaceAlias(alias: string): Promise<{ ok: boolean; error?: string }> {
  const managedWorkspace = workspaceAliasWorkspace;
  if (!managedWorkspace) return { ok: false, error: 'Workspace is no longer available.' };
  return workspaceState.updateWorkspaceAlias(managedWorkspace.id, alias);
}

function openNewWorktree(managedWorkspace: ManagedWorkspace) {
  if (guardManagementTransition(() => openNewWorktree(managedWorkspace))) return;
  workspaceSettingsOpen = false;
  workspaceAliasWorkspace = undefined;
  managementView = undefined;
  worktreeSourceWorkspace = managedWorkspace;
}

async function createIsolatedWorkspace(name: string): Promise<{ ok: boolean; error?: string }> {
  const source = worktreeSourceWorkspace;
  if (!source) return { ok: false, error: 'Source workspace is no longer available.' };
  if (workspaceNavigationGuard && !(await workspaceNavigationGuard())) {
    return { ok: false, error: 'Save the workspace note before creating a worktree.' };
  }
  const result = await workspaceState.createIsolatedWorkspace(source.id, name, tmuxStatus?.available);
  if (result.ok) {
    worktreeSourceWorkspace = undefined;
    restorePanelAfterWorkspaceChange();
  }
  return result;
}

async function createWorkspace() {
  workspaceState.newWorkspaceOpen = false;
  if (guardManagementTransition(() => void createWorkspace())) return;
  if (workspaceNavigationGuard && !(await workspaceNavigationGuard())) return;
  if (await workspaceState.createWorkspace(tmuxStatus?.available)) restorePanelAfterWorkspaceChange();
}

function clearActiveWorkspace() {
  workspaceSettingsOpen = false;
  reopenWithOpen = false;
  workspaceAliasWorkspace = undefined;
  worktreeSourceWorkspace = undefined;
  managementView = undefined;
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
  const previousManagementView = managementView;
  const automationMatch = /^\/workspaces\/([^/]+)\/automations\/?$/.exec(pathname);
  if (automationMatch) {
    managementView = 'automations';
    automationEditId = new URLSearchParams(location.search).get('edit') ?? undefined;
    workspaceState.syncLocation(`/workspaces/${automationMatch[1]}`);
  } else if (/^\/settings\/?$/.test(pathname)) {
    managementView = 'settings';
    const target = new URLSearchParams(location.search).get('workspace') ?? initialWorkspaceId;
    if (target) workspaceState.syncLocation('/workspaces/' + encodeURIComponent(target));
  } else if (/^\/settings\/automations\/?$/.test(pathname)) {
    managementView = 'server-automations';
    automationEditId = undefined;
    const target = new URLSearchParams(location.search).get('workspace') ?? initialWorkspaceId;
    if (target) workspaceState.syncLocation(`/workspaces/${encodeURIComponent(target)}`);
  } else if (/^\/settings\/widgets\/?$/.test(pathname)) {
    managementView = 'widgets';
    const target = new URLSearchParams(location.search).get('workspace') ?? initialWorkspaceId;
    if (target) workspaceState.syncLocation(`/workspaces/${encodeURIComponent(target)}`);
  } else {
    managementView = undefined;
    automationEditId = undefined;
    managementBusy = false;
    managementDirty = false;
    managementClosePrompt = false;
    workspaceState.syncLocation(pathname);
  }
  if (workspaceState.requestedWorkspaceId) restorePanelAfterWorkspaceChange();
  else mobilePanel = managementView ? undefined : 'workspaces';
  if (previousManagementView && !managementView && managementOpenedFromApp) {
    managementOpenedFromApp = false;
    void restoreManagementTrigger(previousManagementView);
  }
  markActiveWorkspaceObserved();
}

async function restartWorkspace(
  managedWorkspace: ManagedWorkspace,
  launchProfileId?: string | null
): Promise<{ ok: boolean; error?: string }> {
  if (workspaceNavigationGuard && !(await workspaceNavigationGuard())) {
    return { ok: false, error: 'Save the workspace note before reopening this workspace.' };
  }
  if (!(await workspaceState.restartWorkspace(managedWorkspace, launchProfileId))) {
    return { ok: false, error: workspaceState.workspaceActionError };
  }
  const restartedWorkspace = workspaceState.workspaces.find((candidate) => candidate.id === managedWorkspace.id);
  if (restartedWorkspace) await openWorkspace(restartedWorkspace);
  return { ok: true };
}

async function closeWorkspace(managedWorkspace: ManagedWorkspace): Promise<{ ok: boolean; error?: string }> {
  if (guardManagementTransition(() => void closeWorkspace(managedWorkspace))) {
    return managementDirty ? { ok: true } : { ok: false, error: 'Wait for the current action to finish.' };
  }
  const wasActive = workspaceState.requestedWorkspaceId === managedWorkspace.id;
  if (wasActive && workspaceNavigationGuard && !(await workspaceNavigationGuard())) {
    return { ok: false, error: 'Save the workspace note before closing this workspace.' };
  }
  if (!(await workspaceState.closeWorkspace(managedWorkspace))) {
    return { ok: false, error: workspaceState.workspaceActionError };
  }
  if (managementView === 'automations' && wasActive) managementView = undefined;
  if (wasActive) mobilePanel = 'workspaces';
  return { ok: true };
}

async function removeWorkspace(managedWorkspace: ManagedWorkspace): Promise<{ ok: boolean; error?: string }> {
  if (guardManagementTransition(() => void removeWorkspace(managedWorkspace))) {
    return managementDirty ? { ok: true } : { ok: false, error: 'Wait for the current action to finish.' };
  }
  const wasActive = workspaceState.requestedWorkspaceId === managedWorkspace.id;
  if (wasActive && workspaceNavigationGuard && !(await workspaceNavigationGuard())) {
    return { ok: false, error: 'Save the workspace note before removing this workspace.' };
  }
  if (!(await workspaceState.removeWorkspace(managedWorkspace))) {
    return { ok: false, error: workspaceState.workspaceActionError };
  }
  if (managementView === 'automations' && wasActive) managementView = undefined;
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
  void openWorkspace(targetWorkspace);
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
  syncedHistoryIndex = historyIndex();
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
        if (event.launchProfiles !== undefined)
          workspaceState.applyLaunchProfiles(event.launchProfiles, event.defaultStartupProfileId);
        if (event.preferences !== undefined) {
          workspaceState.applyWorkspacePreferences(event.preferences, { initialSnapshot: true });
        }
        if (event.launchProfiles !== undefined)
          workspaceState.applyLaunchProfiles(event.launchProfiles, event.defaultStartupProfileId);
      } else if (event.type === 'workspace-added') workspaceState.applyWorkspaceAdded(event.workspace);
      else if (event.type === 'workspace-updated') workspaceState.applyWorkspaceUpdated(event.id, event.changes);
      else if (event.type === 'workspace-removed') workspaceState.applyWorkspaceRemoved(event.id);
      else if (event.type === 'workspace-preferences-updated')
        workspaceState.applyWorkspacePreferences(event.preferences);
      else workspaceState.applyLaunchProfiles(event.launchProfiles, event.defaultStartupProfileId);
    },
  });
  const handlePopState = async (event: PopStateEvent) => {
    const targetHistoryIndex = historyIndex(event.state);
    if (restoringManagementHistory) {
      const shouldPrompt = restoringManagementHistory === 'dirty';
      restoringManagementHistory = undefined;
      syncedHistoryIndex = targetHistoryIndex;
      if (shouldPrompt) managementClosePrompt = true;
      return;
    }
    if (restoringWorkspaceHistory) {
      restoringWorkspaceHistory = false;
      syncedHistoryIndex = targetHistoryIndex;
      return;
    }
    if (managementView && (managementBusy || managementDirty)) {
      restoringManagementHistory = managementDirty ? 'dirty' : 'busy';
      const delta =
        targetHistoryIndex !== undefined && syncedHistoryIndex !== undefined
          ? targetHistoryIndex - syncedHistoryIndex
          : -1;
      history.go(-delta);
      return;
    }
    const currentWorkspacePath = workspaceState.requestedWorkspaceId
      ? `/workspaces/${encodeURIComponent(workspaceState.requestedWorkspaceId)}`
      : '/';
    const targetPath = location.pathname;
    if (workspaceNavigationGuard && targetPath !== currentWorkspacePath) {
      if (!(await workspaceNavigationGuard())) {
        const delta =
          targetHistoryIndex !== undefined && syncedHistoryIndex !== undefined
            ? targetHistoryIndex - syncedHistoryIndex
            : -1;
        restoringWorkspaceHistory = true;
        history.go(-delta);
        return;
      }
      if (location.pathname !== targetPath) return;
    }
    syncedHistoryIndex = targetHistoryIndex;
    syncWorkspaceFromLocation();
  };
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
      <div
        class="dashboard"
        class:terminal-open={workspaceState.hasOpenWorkspace}
        class:management-open={Boolean(managementView)}
      >
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
        >
          {#snippet tools()}
            <AppSidebarActions
              onPorts={() => listeningPortsOpen = true}
              onSettings={() => void openApplicationSettings()}
            />
          {/snippet}
        </WorkspaceNavigator>

        {#if managementView === 'settings'}
          <AppSettingsPage
            launchProfiles={workspaceState.launchProfiles}
            defaultStartupProfileId={workspaceState.defaultStartupProfileId}
            composerHistorySettings={workspaceState.composerHistorySettings}
            workspaces={workspaceState.workspaces}
            close={closeManagementView}
            onSaveLaunchProfiles={(profiles, defaultProfileId, applyDefaultToAll) =>
              workspaceState.updateLaunchProfileSettings(profiles, defaultProfileId, applyDefaultToAll)}
            onSaveComposerHistorySettings={(settings) => workspaceState.updateComposerHistorySettings(settings)}
            onManageAutomations={() => void openServerAutomations(workspaceState.requestedWorkspaceId)}
            onManageWidgets={() => void openStatusWidgets(workspaceState.requestedWorkspaceId)}
            onLogout={connection.authenticationRequired ? () => void logout() : undefined}
            onBusyChange={(value) => managementBusy = value}
            onDirtyChange={(value) => managementDirty = value}
          />
        {:else if managementView === 'server-automations'}
          <AppAutomationsPage
            workspaces={workspaceState.workspaces}
            close={closeManagementView}
            onManage={(workspace, automationId) => void openWorkspaceAutomations(workspace, automationId)}
            onBusyChange={(value) => managementBusy = value}
          />
        {:else if managementView === 'widgets'}
          <StatusPluginSettings
            workspaces={workspaceState.workspaces}
            workspaceId={workspaceState.requestedWorkspaceId}
            close={closeManagementView}
            onBusyChange={(value) => managementBusy = value}
            onDirtyChange={(value) => managementDirty = value}
          />
        {:else if managementView === 'automations' && workspaceState.activeWorkspace}
          {#key `${workspaceState.activeWorkspace.id}:${automationEditId ?? ''}`}
            <WorkspaceAutomationsPage
              workspace={workspaceState.activeWorkspace}
              initialAutomationId={automationEditId}
              close={closeManagementView}
              onBusyChange={(value) => managementBusy = value}
            />
          {/key}
        {:else if workspaceState.activeWorkspace?.state === 'missing'}
          <section class="unavailable-sheet" aria-labelledby="ended-workspace-title">
            <TerminalHeader
              projectName={workspaceName(workspaceState.activeWorkspace)}
              cwd={workspaceState.activeWorkspace.cwd}
              isWorktree={isWorktreeWorkspace(workspaceState.activeWorkspace)}
              branch={workspaceState.activeWorkspace.worktreeBranch}
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
              close={openWorkspaceNavigator}
              onUpdateNote={(workspaceId, note) => workspaceState.updateWorkspaceNote(workspaceId, note)}
              onLoadNote={(workspaceId, refresh) => workspaceState.loadWorkspaceNote(workspaceId, refresh)}
              composerHistoryEnabled={workspaceState.composerHistorySettings.enabled}
              onRecordComposerPrompt={(workspaceId, prompt) => workspaceState.recordWorkspaceComposerPrompt(workspaceId, prompt)}
              onLoadComposerPrompts={(workspaceId, refresh) => workspaceState.loadWorkspaceComposerPrompts(workspaceId, refresh)}
              onInputActivity={(workspaceId, timestamp) => workspaceState.recordWorkspaceInput(workspaceId, timestamp)}
              onOutputActivity={(workspaceId, active, timestamp) => workspaceState.recordWorkspaceOutput(workspaceId, active, timestamp, terminalIsObserved(workspaceId))}
              onTerminalPresentationChange={setTerminalPresentation}
              {mobilePanel}
              onMobilePanelChange={setMobilePanel}
              {repositoryPanelOpen}
              onRepositoryPanelOpenChange={setRepositoryPanelOpen}
              {repositoryTab}
              onRepositoryTabChange={setRepositoryTab}
              onNavigationGuardChange={(guard) => workspaceNavigationGuard = guard}
              onManageStatusWidgets={() => void openStatusWidgets(workspaceState.activeWorkspace?.id)}
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

        {#if managementClosePrompt}
          <ConfirmDialog
            title={managementView === 'settings' ? 'Discard unsaved profile changes?' : 'Discard unsaved widget changes?'}
            description={managementView === 'settings'
              ? 'Your launch profile edits have not been saved. Discard them and leave settings?'
              : 'Your widget edits have not been saved. Discard them and leave status widget settings?'}
            confirmLabel="Discard changes"
            close={cancelManagementClosePrompt}
            onConfirm={discardManagementChanges}
          />
        {/if}

        {#if workspaceSettingsOpen && workspaceState.activeWorkspace}
          <WorkspaceSettings
            workspace={workspaceState.activeWorkspace}
            profiles={workspaceState.launchProfiles}
            onClose={() => workspaceSettingsOpen = false}
            onSave={(startupProfileId) =>
              workspaceState.updateWorkspaceStartup(
                workspaceState.activeWorkspace!.id,
                workspaceState.launchProfiles,
                startupProfileId
              )}
            onManageProfiles={() => {
              workspaceSettingsOpen = false;
              void openApplicationSettings();
            }}
          />
        {/if}

        {#if listeningPortsOpen}
          <ListeningPortsDialog close={() => listeningPortsOpen = false} />
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
@media (max-width: 63.999rem) {
  .dashboard.management-open {
    padding: 0;
  }
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
