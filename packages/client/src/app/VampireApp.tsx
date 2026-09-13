import { observer } from 'mobx-react-lite';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { LoginScreen } from '~/features/auth/LoginScreen.tsx';
import { TmuxSetupScreen } from '~/features/system/TmuxSetupScreen.tsx';
import { WorkspaceState } from '~/features/workspace/model/workspace-state.ts';
import { NewWorktreeDialog } from '~/features/workspace/NewWorktreeDialog.tsx';
import { UnavailableWorkspace } from '~/features/workspace/UnavailableWorkspace.tsx';
import { navigationGuard } from '~/shared/lib/navigation-guard.ts';
import { Spinner } from '~/shared/ui/index.ts';
import { useConnectionStore } from './model/connection-store.ts';
import { WorkspaceNavigator } from './WorkspaceNavigator.tsx';
import { WorkspaceTerminal } from './WorkspaceTerminal.tsx';
import './vampire-app.css';

const AppSettingsDialog = lazy(() =>
  import('./AppSettingsDialog.tsx').then((module) => ({ default: module.AppSettingsDialog })),
);
const ListeningPortsDialog = lazy(() =>
  import('~/features/system/ListeningPortsDialog.tsx').then((module) => ({ default: module.ListeningPortsDialog })),
);
const WorkspaceSettingsDialog = lazy(() =>
  import('~/features/workspace/WorkspaceSettingsDialog.tsx').then((module) => ({
    default: module.WorkspaceSettingsDialog,
  })),
);

function navigate(path: string) {
  const currentIndex =
    typeof history.state?.vampireNavigationIndex === 'number' ? history.state.vampireNavigationIndex : 0;
  history.pushState({ ...history.state, vampireNavigationIndex: currentIndex + 1 }, '', path);
  window.dispatchEvent(new Event('vampire:navigation'));
}

function replaceNavigation(path: string) {
  const currentIndex =
    typeof history.state?.vampireNavigationIndex === 'number' ? history.state.vampireNavigationIndex : 0;
  history.replaceState({ ...history.state, vampireNavigationIndex: currentIndex }, '', path);
  window.dispatchEvent(new Event('vampire:navigation'));
}

function legacyManagementPath(pathname: string, search: string): string | undefined {
  const params = new URLSearchParams(search);
  const workspaceWidgets = /^\/settings\/widgets\/?$/.test(pathname);
  const appAutomations = /^\/settings\/automations\/?$/.test(pathname);
  if (workspaceWidgets || appAutomations) {
    const canonical = new URLSearchParams();
    const workspaceId = params.get('workspace');
    if (workspaceId) canonical.set('workspace', workspaceId);
    canonical.set('section', workspaceWidgets ? 'widgets' : 'automations');
    const automationId = params.get('edit');
    if (appAutomations && automationId) canonical.set('edit', automationId);
    return `/settings?${canonical.toString()}`;
  }
  const workspaceAutomation = /^\/workspaces\/([^/]+)\/automations\/?$/.exec(pathname);
  if (!workspaceAutomation) return undefined;
  const workspaceId = decodeURIComponent(workspaceAutomation[1]!);
  const automationId = params.get('edit');
  if (params.get('return') === 'all') {
    const canonical = new URLSearchParams({ workspace: workspaceId, section: 'automations' });
    if (automationId) canonical.set('edit', automationId);
    return `/settings?${canonical.toString()}`;
  }
  const canonical = new URLSearchParams({ section: 'automations' });
  if (automationId) canonical.set('edit', automationId);
  return `/workspaces/${encodeURIComponent(workspaceId)}/settings?${canonical.toString()}`;
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
  const terminalOpen = Boolean(
    workspaceState.requestedWorkspaceId &&
      !settingsOpen &&
      !workspaceSettingsId &&
      workspaceState.activeWorkspace?.state !== 'missing',
  );
  useEffect(() => {
    if (!terminalOpen) return;
    const frame = window.requestAnimationFrame(() => window.scrollTo({ top: 0, left: 0, behavior: 'auto' }));
    return () => window.cancelAnimationFrame(frame);
  }, [terminalOpen, workspaceState.requestedWorkspaceId]);
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
      const queryWorkspace = new URLSearchParams(location.search).get('workspace') ?? undefined;
      const canonicalPath = legacyManagementPath(location.pathname, location.search);
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
            acceptedLocationRef.current,
          );
        }
        return;
      }
      if (canonicalPath && canonicalPath !== targetLocation) {
        replaceNavigation(canonicalPath);
        return;
      }
      acceptedLocationRef.current = targetLocation;
      acceptedNavigationIndexRef.current = targetNavigationIndex;
      setSettingsOpen(/^\/settings\/?$/.test(location.pathname));
      setWorkspaceSettingsId(workspaceSettings ? decodeURIComponent(workspaceSettings[1]!) : undefined);
      if (workspaceSettings) workspaceState.syncLocation(`/workspaces/${workspaceSettings[1]}`);
      else if (/^\/settings(?:\/|$)/.test(location.pathname))
        workspaceState.syncLocation(queryWorkspace ? `/workspaces/${encodeURIComponent(queryWorkspace)}` : '/');
      else workspaceState.syncLocation(location.pathname);
    };
    window.addEventListener('popstate', syncRoute);
    window.addEventListener('vampire:navigation', syncRoute);
    void syncRoute();
    const shortcut = (event: KeyboardEvent) => {
      const digitMatch = /^(?:Digit|Numpad)(\d)$/.exec(event.code);
      if (
        event.repeat ||
        event.isComposing ||
        event.shiftKey ||
        event.altKey ||
        event.ctrlKey ||
        !event.metaKey ||
        !digitMatch
      )
        return;
      if (document.querySelector('[data-vampire-overlay]')) return;
      const index = digitMatch[1] === '0' ? 9 : Number(digitMatch[1]) - 1;
      const workspace = workspaceState.shortcutWorkspaces[index];
      if (!workspace) return;
      event.preventDefault();
      event.stopPropagation();
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
          onSubmit={() => connection.unlock()}
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
    navigate(
      workspace ? `/settings?workspace=${encodeURIComponent(workspace)}&section=widgets` : '/settings?section=widgets',
    );
  };
  const worktreeSource = workspaceState.workspaces.find((workspace) => workspace.id === worktreeSourceId);
  const settingsWorkspace = workspaceState.workspaces.find((workspace) => workspace.id === workspaceSettingsId);
  return (
    <main className={terminalOpen ? 'terminal-open' : undefined} data-client-runtime="react">
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
                : '/settings',
            )
          }
          onNewWorktree={setWorktreeSourceId}
          onWorkspaceSettings={(id) => navigate(`/workspaces/${encodeURIComponent(id)}/settings`)}
        />
        {settingsOpen ? (
          <Suspense fallback={null}>
            <AppSettingsDialog
              initialAutomationId={new URLSearchParams(location.search).get('edit') ?? undefined}
              initialSection={
                new URLSearchParams(location.search).get('section') === 'profiles'
                  ? 'profiles'
                  : new URLSearchParams(location.search).get('section') === 'terminal'
                    ? 'terminal'
                    : new URLSearchParams(location.search).get('section') === 'automations'
                      ? 'automations'
                      : new URLSearchParams(location.search).get('section') === 'widgets'
                        ? 'widgets'
                        : 'general'
              }
              state={workspaceState}
              navigate={navigate}
              onClose={() => {
                const focusSelector =
                  new URLSearchParams(location.search).get('section') === 'widgets'
                    ? '[aria-label="Manage status widgets"]'
                    : '.workspace-row-shell.selected [aria-label^="Workspace actions for"]';
                navigate(
                  workspaceState.requestedWorkspaceId
                    ? `/workspaces/${encodeURIComponent(workspaceState.requestedWorkspaceId)}`
                    : '/',
                );
                focusSoon(focusSelector);
              }}
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
            initialSection={
              new URLSearchParams(location.search).get('section') === 'terminal'
                ? 'terminal'
                : new URLSearchParams(location.search).get('section') === 'automations'
                  ? 'automations'
                  : 'general'
            }
            initialAutomationId={new URLSearchParams(location.search).get('edit') ?? undefined}
            workspace={settingsWorkspace}
            state={workspaceState}
            onManageProfiles={() =>
              navigate(`/settings?workspace=${encodeURIComponent(settingsWorkspace.id)}&section=profiles`)
            }
            onClose={() => {
              navigate(`/workspaces/${encodeURIComponent(settingsWorkspace.id)}`);
              focusSoon(
                window.matchMedia('(max-width: 63.999rem)').matches
                  ? '[aria-label="Open workspaces"]'
                  : '.workspace-row-shell.selected [aria-label^="Workspace actions for"]',
              );
            }}
          />
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
