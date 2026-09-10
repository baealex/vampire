import { observer } from 'mobx-react-lite';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { LoginScreen } from '~/features/auth/LoginScreen.tsx';
import { TmuxSetupScreen } from '~/features/system/TmuxSetupScreen.tsx';
import { NewWorktreeDialog } from '~/features/workspace/NewWorktreeDialog.tsx';
import { UnavailableWorkspace } from '~/features/workspace/UnavailableWorkspace.tsx';
import { WorkspaceTerminal } from './WorkspaceTerminal.tsx';
import { WorkspaceNavigator } from './WorkspaceNavigator.tsx';
import { WorkspaceState } from '~/features/workspace/model/workspace-state.ts';
import { Spinner } from '~/shared/ui/index.ts';
import { useConnectionStore } from './model/connection-store.ts';
import { navigationGuard } from '~/shared/lib/navigation-guard.ts';
import './vampire-app.css';

const AppSettingsDialog = lazy(() =>
  import('./AppSettingsDialog.tsx').then((module) => ({ default: module.AppSettingsDialog }))
);
const ListeningPortsDialog = lazy(() =>
  import('~/features/system/ListeningPortsDialog.tsx').then((module) => ({ default: module.ListeningPortsDialog }))
);
const StatusPluginSettingsDialog = lazy(() =>
  import('~/features/status/StatusPluginSettingsDialog.tsx').then((module) => ({
    default: module.StatusPluginSettingsDialog,
  }))
);
const AutomationManagerDialog = lazy(() =>
  import('~/features/workspace/AutomationManagerDialog.tsx').then((module) => ({
    default: module.AutomationManagerDialog,
  }))
);
const WorkspaceSettingsDialog = lazy(() =>
  import('~/features/workspace/WorkspaceSettingsDialog.tsx').then((module) => ({
    default: module.WorkspaceSettingsDialog,
  }))
);
const AppAutomationsPage = lazy(() =>
  import('./AppAutomationsPage.tsx').then((module) => ({ default: module.AppAutomationsPage }))
);

function navigate(path: string) {
  const currentIndex =
    typeof history.state?.vampireNavigationIndex === 'number' ? history.state.vampireNavigationIndex : 0;
  history.pushState({ ...history.state, vampireNavigationIndex: currentIndex + 1 }, '', path);
  window.dispatchEvent(new Event('vampire:navigation'));
}

function focusSoon(selector: string) {
  window.setTimeout(() => {
    const target = document.querySelector<HTMLElement>(selector);
    if (target) {
      target.dataset.terminalAutofocus = 'preserve';
      target.focus({ preventScroll: true });
      window.setTimeout(() => {
        delete target.dataset.terminalAutofocus;
      }, 1_000);
    }
  }, 100);
}

const VampireApp = observer(function VampireApp() {
  const connection = useConnectionStore();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [portsOpen, setPortsOpen] = useState(false);
  const [management, setManagement] = useState<'automations' | 'widgets'>();
  const [managementWorkspaceId, setManagementWorkspaceId] = useState<string>();
  const [worktreeSourceId, setWorktreeSourceId] = useState<string>();
  const [workspaceSettingsId, setWorkspaceSettingsId] = useState<string>();
  const [mobileNavigatorOpen, setMobileNavigatorOpen] = useState(false);
  const acceptedLocationRef = useRef(`${location.pathname}${location.search}`);
  const acceptedNavigationIndexRef = useRef(0);
  const restoringHistoryRef = useRef(false);
  const workspaceStateRef = useRef<WorkspaceState | null>(null);
  workspaceStateRef.current ??= new WorkspaceState({
    navigate(path) {
      navigate(path);
    },
    onUnauthorized() {
      useConnectionStore.getState().markUnauthenticated();
    },
    isWorkspaceObserved(workspaceId) {
      return workspaceStateRef.current?.requestedWorkspaceId === workspaceId && document.visibilityState === 'visible';
    },
  });
  const workspaceState = workspaceStateRef.current;
  useEffect(() => {
    if (typeof history.state?.vampireNavigationIndex !== 'number') {
      history.replaceState({ ...history.state, vampireNavigationIndex: 0 }, '', location.href);
    }
    acceptedNavigationIndexRef.current = history.state.vampireNavigationIndex;
    workspaceState.restoreBrowserPreferences(localStorage);
    const syncRoute = async (event?: Event) => {
      if (event?.type === 'popstate' && restoringHistoryRef.current) {
        restoringHistoryRef.current = false;
        return;
      }
      const targetLocation = `${location.pathname}${location.search}`;
      const targetNavigationIndex =
        typeof history.state?.vampireNavigationIndex === 'number'
          ? history.state.vampireNavigationIndex
          : acceptedNavigationIndexRef.current;
      const workspaceSettings = /^\/workspaces\/([^/]+)\/settings\/?$/.exec(location.pathname);
      const workspaceAutomations = /^\/workspaces\/([^/]+)\/automations\/?$/.exec(location.pathname);
      const plainWorkspace = /^\/workspaces\/([^/]+)\/?$/.exec(location.pathname);
      const queryWorkspace = new URLSearchParams(location.search).get('workspace') ?? undefined;
      const nextWorkspaceId = decodeURIComponent(
        workspaceSettings?.[1] ?? workspaceAutomations?.[1] ?? plainWorkspace?.[1] ?? queryWorkspace ?? ''
      );
      const activeGuard = navigationGuard();
      if (
        activeGuard &&
        (event?.type === 'popstate' || targetLocation !== acceptedLocationRef.current) &&
        !(await activeGuard())
      ) {
        const delta = acceptedNavigationIndexRef.current - targetNavigationIndex;
        if (event?.type === 'popstate' && delta !== 0) {
          restoringHistoryRef.current = true;
          history.go(delta);
        } else {
          history.replaceState(
            { ...history.state, vampireNavigationIndex: acceptedNavigationIndexRef.current },
            '',
            acceptedLocationRef.current
          );
        }
        return;
      }
      acceptedLocationRef.current = targetLocation;
      acceptedNavigationIndexRef.current = targetNavigationIndex;
      setSettingsOpen(/^\/settings\/?$/.test(location.pathname));
      setManagement(
        /^\/settings\/widgets\/?$/.test(location.pathname)
          ? 'widgets'
          : /^\/settings\/automations\/?$/.test(location.pathname) || workspaceAutomations
            ? 'automations'
            : undefined
      );
      setManagementWorkspaceId(workspaceAutomations ? decodeURIComponent(workspaceAutomations[1]!) : queryWorkspace);
      setWorkspaceSettingsId(workspaceSettings ? decodeURIComponent(workspaceSettings[1]!) : undefined);
      if (workspaceSettings || workspaceAutomations)
        workspaceState.syncLocation(`/workspaces/${workspaceSettings?.[1] ?? workspaceAutomations?.[1]}`);
      else if (/^\/settings(?:\/|$)/.test(location.pathname))
        workspaceState.syncLocation(queryWorkspace ? `/workspaces/${encodeURIComponent(queryWorkspace)}` : '/');
      else workspaceState.syncLocation(location.pathname);
    };
    void syncRoute();
    window.addEventListener('popstate', syncRoute);
    window.addEventListener('vampire:navigation', syncRoute);
    const shortcut = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || !/^Digit[0-9]$/.test(event.code)) return;
      const index = event.code === 'Digit0' ? 9 : Number(event.code.slice(-1)) - 1;
      const workspace = workspaceState.displayedWorkspaces[index];
      if (!workspace) return;
      event.preventDefault();
      navigate(`/workspaces/${encodeURIComponent(workspace.id)}`);
    };
    window.addEventListener('keydown', shortcut, { capture: true });
    const stop = connection.start({
      refreshWorkspaces: (options) => workspaceState.refresh(options),
      onVisible: () => workspaceState.markWorkspaceObserved(workspaceState.requestedWorkspaceId ?? ''),
      onWorkspaceEvent(event) {
        if (event.type === 'workspaces-snapshot') {
          workspaceState.applyWorkspaceSnapshot(event.workspaces);
          if (event.preferences !== undefined)
            workspaceState.applyWorkspacePreferences(event.preferences, { initialSnapshot: true });
          if (event.launchProfiles !== undefined)
            workspaceState.applyLaunchProfiles(event.launchProfiles, event.defaultStartupProfileId);
        } else if (event.type === 'workspace-added') workspaceState.applyWorkspaceAdded(event.workspace);
        else if (event.type === 'workspace-updated') workspaceState.applyWorkspaceUpdated(event.id, event.changes);
        else if (event.type === 'workspace-removed') workspaceState.applyWorkspaceRemoved(event.id);
        else if (event.type === 'workspace-preferences-updated')
          workspaceState.applyWorkspacePreferences(event.preferences);
        else if (event.type === 'launch-profiles-updated')
          workspaceState.applyLaunchProfiles(event.launchProfiles, event.defaultStartupProfileId);
      },
    });
    return () => {
      stop();
      workspaceState.dispose();
      window.removeEventListener('popstate', syncRoute);
      window.removeEventListener('vampire:navigation', syncRoute);
      window.removeEventListener('keydown', shortcut, { capture: true });
    };
  }, [workspaceState]);
  if (connection.checking)
    return (
      <main>
        <div className="loading-state">
          <Spinner /> Connecting to Vampire…
        </div>
      </main>
    );
  if (!connection.authenticated)
    return (
      <main>
        <LoginScreen
          token={connection.token}
          error={connection.loginError || connection.errorMessage}
          onTokenChange={connection.setToken}
          onSubmit={() => void connection.unlock()}
        />
      </main>
    );
  if (connection.tmuxStatus?.available === false) return <TmuxSetupScreen status={connection.tmuxStatus} />;
  if (!workspaceState.workspacesLoaded && workspaceState.loading)
    return (
      <main>
        <div className="loading-state">
          <Spinner /> Loading workspaces…
        </div>
      </main>
    );
  const openStatusWidgets = () => {
    const workspace = workspaceState.requestedWorkspaceId;
    navigate(workspace ? `/settings/widgets?workspace=${encodeURIComponent(workspace)}` : '/settings/widgets');
  };
  const openAutomations = (workspaceId?: string) => {
    navigate(workspaceId ? `/workspaces/${encodeURIComponent(workspaceId)}/automations` : '/settings/automations');
  };
  const worktreeSource = workspaceState.workspaces.find((workspace) => workspace.id === worktreeSourceId);
  const settingsWorkspace = workspaceState.workspaces.find((workspace) => workspace.id === workspaceSettingsId);
  return (
    <main data-client-runtime="react">
      <div
        className={`app-shell${workspaceState.requestedWorkspaceId ? ' workspace-open' : ''}${
          mobileNavigatorOpen ? ' mobile-navigator-open' : ''
        }`}
      >
        <WorkspaceNavigator
          state={workspaceState}
          mobileOpen={mobileNavigatorOpen}
          onClose={() => setMobileNavigatorOpen(false)}
          onPorts={() => setPortsOpen(true)}
          onSettings={() =>
            navigate(
              workspaceState.requestedWorkspaceId
                ? `/settings?workspace=${encodeURIComponent(workspaceState.requestedWorkspaceId)}`
                : '/settings'
            )
          }
          onAutomations={openAutomations}
          onNewWorktree={setWorktreeSourceId}
          onWorkspaceSettings={(id) => navigate(`/workspaces/${encodeURIComponent(id)}/settings`)}
        />
        {settingsOpen ? (
          <Suspense fallback={null}>
            <AppSettingsDialog
              state={workspaceState}
              onClose={() => {
                navigate(
                  workspaceState.requestedWorkspaceId
                    ? `/workspaces/${encodeURIComponent(workspaceState.requestedWorkspaceId)}`
                    : '/'
                );
                focusSoon('.workspace-row-shell.selected [aria-label^="Workspace actions for"]');
              }}
              onManageAutomations={() =>
                navigate(
                  workspaceState.requestedWorkspaceId
                    ? `/settings/automations?workspace=${encodeURIComponent(workspaceState.requestedWorkspaceId)}`
                    : '/settings/automations'
                )
              }
              onManageWidgets={openStatusWidgets}
              onLogout={
                connection.authenticationRequired
                  ? () => {
                      void connection.logout().then((ok) => {
                        if (ok) {
                          workspaceState.reset();
                          navigate('/');
                        }
                      });
                    }
                  : undefined
              }
            />
          </Suspense>
        ) : settingsWorkspace ? (
          <WorkspaceSettingsDialog
            workspace={settingsWorkspace}
            state={workspaceState}
            onManageProfiles={() => navigate(`/settings?workspace=${encodeURIComponent(settingsWorkspace.id)}`)}
            onClose={() => navigate(`/workspaces/${encodeURIComponent(settingsWorkspace.id)}`)}
          />
        ) : management === 'widgets' ? (
          <Suspense fallback={null}>
            <StatusPluginSettingsDialog
              workspaceId={managementWorkspaceId ?? workspaceState.requestedWorkspaceId}
              workspaces={workspaceState.workspaces}
              onClose={() => {
                navigate(
                  workspaceState.requestedWorkspaceId
                    ? `/workspaces/${encodeURIComponent(workspaceState.requestedWorkspaceId)}`
                    : '/'
                );
                focusSoon('[aria-label="Manage status widgets"]');
              }}
            />
          </Suspense>
        ) : management === 'automations' ? (
          <Suspense fallback={null}>
            {location.pathname.startsWith('/settings/automations') ? (
              <AppAutomationsPage
                workspaces={workspaceState.workspaces}
                navigate={navigate}
                close={() =>
                  navigate(
                    workspaceState.requestedWorkspaceId
                      ? `/settings?workspace=${encodeURIComponent(workspaceState.requestedWorkspaceId)}`
                      : '/settings'
                  )
                }
              />
            ) : (
              <AutomationManagerDialog
                workspaces={workspaceState.workspaces}
                initialWorkspaceId={managementWorkspaceId ?? workspaceState.requestedWorkspaceId}
                initialAutomationId={new URLSearchParams(location.search).get('edit') ?? undefined}
                onNavigate={navigate}
                onClose={() => {
                  const returningToAll = new URLSearchParams(location.search).get('return') === 'all';
                  const fromSettings = location.pathname.startsWith('/settings/');
                  navigate(
                    returningToAll
                      ? `/settings/automations?workspace=${encodeURIComponent(workspaceState.requestedWorkspaceId ?? '')}`
                      : fromSettings
                        ? workspaceState.requestedWorkspaceId
                          ? `/settings?workspace=${encodeURIComponent(workspaceState.requestedWorkspaceId)}`
                          : '/settings'
                        : workspaceState.requestedWorkspaceId
                          ? `/workspaces/${encodeURIComponent(workspaceState.requestedWorkspaceId)}`
                          : '/'
                  );
                  if (!fromSettings && !returningToAll) {
                    focusSoon(
                      window.matchMedia('(max-width: 63.999rem)').matches
                        ? '[aria-label="Open workspaces"]'
                        : '.workspace-row-shell.selected [aria-label^="Workspace actions for"]'
                    );
                  }
                }}
              />
            )}
          </Suspense>
        ) : workspaceState.activeWorkspace?.state === 'missing' &&
          workspaceState.activeWorkspace.workspaceAvailable !== false ? (
          <UnavailableWorkspace state={workspaceState} workspace={workspaceState.activeWorkspace} />
        ) : workspaceState.requestedWorkspaceId ? (
          <WorkspaceTerminal
            key={workspaceState.requestedWorkspaceId}
            state={workspaceState}
            statusPlugins={connection.statusPlugins}
            onOpenWorkspaces={() => setMobileNavigatorOpen(true)}
            onManageStatusWidgets={openStatusWidgets}
          />
        ) : (
          <section className="empty-workbench">
            <SquareTerminalPlaceholder />
          </section>
        )}
      </div>
      <Suspense fallback={null}>
        {portsOpen ? <ListeningPortsDialog onClose={() => setPortsOpen(false)} /> : null}
        {worktreeSource ? (
          <NewWorktreeDialog
            source={worktreeSource}
            state={workspaceState}
            onClose={() => setWorktreeSourceId(undefined)}
          />
        ) : null}
      </Suspense>
    </main>
  );
});

function SquareTerminalPlaceholder() {
  return (
    <>
      <h2>Select a workspace</h2>
      <p>Choose a workspace from the sidebar or start a new one.</p>
    </>
  );
}

export default VampireApp;
