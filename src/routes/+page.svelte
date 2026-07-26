<script lang="ts">
	import { pushState } from '$app/navigation';
	import { onMount, tick } from 'svelte';
	import CircleHelp from '@lucide/svelte/icons/circle-help';
	import Keyboard from '@lucide/svelte/icons/keyboard';
	import PanelLeft from '@lucide/svelte/icons/panel-left';
	import SquareTerminal from '@lucide/svelte/icons/square-terminal';
	import TmuxSetupNotice from '$lib/TmuxSetupNotice.svelte';
	import WorkspaceWorkbench from '$lib/repository/WorkspaceWorkbench.svelte';
	import SessionActionsDialog from '$lib/session/SessionActionsDialog.svelte';
	import SessionNavigator from '$lib/session/SessionNavigator.svelte';
	import type { ManagedSession, SessionOrderMode } from '$lib/session/types';
	import { maxTimestamp, projectName, sortSessions } from '$lib/session/view';
	import type { TmuxStatus } from '$lib/tmux-status';

	export let initialSessionId: string | undefined = undefined;

	let authenticationRequired = true;
	let authenticated = false;
	let checking = true;
	let loading = false;
	let token = '';
	let loginError = '';
	let errorMessage = '';
	let sessions: ManagedSession[] = [];
	let cwd = '';
	let starting = false;
	let startError = '';
	let newSessionOpen = false;
	let sessionsLoaded = false;
	let activeSession: ManagedSession | undefined;
	let sessionsRequestVersion = 0;
	let requestedSessionId = initialSessionId;
	let sessionAction: 'restart' | 'close' | 'remove' | undefined;
	let sessionActionError = '';
	let sessionOrderMode: SessionOrderMode = 'recent';
	let manualSessionOrder: string[] = [];
	let activeOutputSessionId: string | undefined;
	let sessionShortcutModifier = 'Ctrl';
	let useMetaSessionShortcuts = false;
	let transportSecure = true;
	let tmuxStatus: TmuxStatus | undefined;
	let mobileSessionsOpen = !initialSessionId;
	let sessionActionsSession: ManagedSession | undefined;
	let sessionActionsTrigger: HTMLElement | undefined;
	const activityRequestTimers = new Map<string, number>();
	let displayedSessions: ManagedSession[] = [];

	$: displayedSessions = sortSessions(sessions, sessionOrderMode, manualSessionOrder);

	async function request<T>(path: string, init?: RequestInit): Promise<T> {
		const response = await fetch(path, init);
		if (!response.ok) {
			const body = await response.json().catch(() => ({}));
			throw new Error(typeof body.message === 'string' ? body.message : 'Request failed');
		}
		return response.json() as Promise<T>;
	}

	async function refreshSessions(options: { quiet?: boolean } = {}) {
		const requestVersion = ++sessionsRequestVersion;
		if (!options.quiet) loading = true;
		errorMessage = '';
		try {
			const data = await request<{ sessions: ManagedSession[] }>('/api/sessions');
			if (requestVersion !== sessionsRequestVersion) return;
			const localActivity = new Map(sessions.map((session) => [session.id, session.lastActiveAt]));
			const localOutput = new Map(sessions.map((session) => [session.id, session.lastOutputAt]));
			sessions = data.sessions.map((session) => ({
				...session,
				lastActiveAt: Math.max(session.lastActiveAt, localActivity.get(session.id) ?? 0),
				lastOutputAt: maxTimestamp(session.lastOutputAt, localOutput.get(session.id) ?? null)
			}));
			syncManualSessionOrder();
			if (requestedSessionId) {
				activeSession = sessions.find((session) => session.id === requestedSessionId);
			} else if (activeSession) {
				activeSession = sessions.find((session) => session.id === activeSession?.id) ?? activeSession;
			}
			if (!sessionsLoaded) {
				newSessionOpen = sessions.length === 0;
				sessionsLoaded = true;
			}
		} catch (error) {
			if (requestVersion !== sessionsRequestVersion) return;
			if (error instanceof Error && error.message === 'Unauthorized') {
				authenticated = false;
			} else {
				errorMessage = error instanceof Error ? error.message : 'Unable to load sessions';
			}
		} finally {
			if (!options.quiet) loading = false;
		}
	}

	async function unlock() {
		loginError = '';
		try {
			await request<{ ok: boolean }>('/api/login', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ token })
			});
			token = '';
			authenticated = true;
			await refreshSessions();
		} catch (error) {
			loginError = error instanceof Error && error.message === 'Unauthorized'
				? 'That access token did not work.'
				: error instanceof Error ? error.message : 'Unable to connect';
		}
	}

	async function logout() {
		try {
			await request<{ ok: boolean }>('/api/login', { method: 'DELETE' });
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Unable to sign out';
			return;
		}
		authenticated = false;
		activeSession = undefined;
		requestedSessionId = undefined;
		sessions = [];
		pushState('/', {});
	}

	async function createSession() {
		if (tmuxStatus && !tmuxStatus.available) {
			startError = 'Install tmux on the server computer before starting a session.';
			return;
		}
		starting = true;
		startError = '';
		try {
			const data = await request<{ session: ManagedSession }>('/api/sessions', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ cwd })
			});
			sessionsRequestVersion += 1;
			cwd = '';
			newSessionOpen = false;
			sessions = [data.session, ...sessions.filter((session) => session.id !== data.session.id)];
			manualSessionOrder = [data.session.id, ...manualSessionOrder.filter((id) => id !== data.session.id)];
			persistManualSessionOrder();
			openSession(data.session);
			void refreshSessions({ quiet: true });
		} catch (error) {
			startError = error instanceof Error ? error.message : 'Unable to start the shell';
		} finally {
			starting = false;
		}
	}

	async function updateSessionNote(sessionId: string, note: string) {
		const data = await request<{ note: string }>(`/api/sessions/${encodeURIComponent(sessionId)}/note`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ note })
		});
		sessions = sessions.map((session) => session.id === sessionId ? { ...session, note: data.note } : session);
		if (activeSession?.id === sessionId) activeSession = { ...activeSession, note: data.note };
	}

	function persistManualSessionOrder() {
		window.localStorage.setItem('vampire:session-order', JSON.stringify(manualSessionOrder));
	}

	function syncManualSessionOrder() {
		const sessionIds = new Set(sessions.map((session) => session.id));
		const nextOrder = [
			...manualSessionOrder.filter((id) => sessionIds.has(id)),
			...sessions.map((session) => session.id).filter((id) => !manualSessionOrder.includes(id))
		];
		if (nextOrder.join('\0') === manualSessionOrder.join('\0')) return;
		manualSessionOrder = nextOrder;
		persistManualSessionOrder();
	}

	function setSessionOrderMode(mode: SessionOrderMode) {
		sessionOrderMode = mode;
		window.localStorage.setItem('vampire:session-order-mode', mode);
		if (mode === 'manual') syncManualSessionOrder();
	}

	function reorderSession(draggedId: string, targetId: string, position: 'before' | 'after') {
		if (draggedId === targetId) return;
		const order = displayedSessions.map((session) => session.id).filter((id) => id !== draggedId);
		const targetIndex = order.indexOf(targetId);
		if (targetIndex < 0) return;
		order.splice(targetIndex + (position === 'after' ? 1 : 0), 0, draggedId);
		manualSessionOrder = order;
		persistManualSessionOrder();
	}

	function recordSessionInput(sessionId: string, timestamp: number) {
		sessions = sessions.map((session) => session.id === sessionId ? { ...session, lastActiveAt: timestamp } : session);
		if (activeSession?.id === sessionId) activeSession = { ...activeSession, lastActiveAt: timestamp };

		const existingTimer = activityRequestTimers.get(sessionId);
		if (existingTimer) window.clearTimeout(existingTimer);
		activityRequestTimers.set(sessionId, window.setTimeout(() => {
			activityRequestTimers.delete(sessionId);
			void request<{ lastActiveAt: number }>(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'PATCH' })
				.then(({ lastActiveAt }) => {
					sessions = sessions.map((session) => session.id === sessionId
						? { ...session, lastActiveAt: Math.max(session.lastActiveAt, lastActiveAt) }
						: session);
				})
				.catch(() => undefined);
		}, 600));
	}

	function recordSessionOutput(sessionId: string, active: boolean, timestamp?: number) {
		if (active) {
			activeOutputSessionId = sessionId;
			const outputAt = timestamp ?? Date.now();
			sessions = sessions.map((session) => session.id === sessionId
				? { ...session, lastOutputAt: maxTimestamp(session.lastOutputAt, outputAt) }
				: session);
			if (activeSession?.id === sessionId) {
				activeSession = { ...activeSession, lastOutputAt: maxTimestamp(activeSession.lastOutputAt, outputAt) };
			}
		}
		else if (activeOutputSessionId === sessionId) activeOutputSessionId = undefined;
	}

	function openSession(session: ManagedSession) {
		mobileSessionsOpen = false;
		if (activeSession?.id === session.id && requestedSessionId === session.id) return;
		requestedSessionId = session.id;
		activeSession = session;
		sessionActionError = '';
		pushState(`/sessions/${encodeURIComponent(session.id)}`, {});
	}

	function handleSessionShortcut(event: KeyboardEvent) {
		const digitMatch = /^(?:Digit|Numpad)(\d)$/.exec(event.code);
		if (event.defaultPrevented || event.repeat || event.isComposing || event.shiftKey || !digitMatch) return;
		const primaryModifier = useMetaSessionShortcuts ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
		const fallbackModifier = event.altKey && !event.metaKey && !event.ctrlKey;
		if (!primaryModifier && !fallbackModifier) return;

		const digit = digitMatch[1];
		const index = digit === '0' ? 9 : Number(digit) - 1;
		const targetSession = displayedSessions[index];
		if (!targetSession) return;
		event.preventDefault();
		event.stopPropagation();
		openSession(targetSession);
	}

	function clearActiveSession() {
		requestedSessionId = undefined;
		activeSession = undefined;
		mobileSessionsOpen = true;
		sessionActionError = '';
		pushState('/', {});
	}

	function openSessionNavigator() {
		mobileSessionsOpen = true;
	}

	function closeSessionNavigator() {
		if (activeSession || requestedSessionId) mobileSessionsOpen = false;
	}

	function openSessionActions(session: ManagedSession, trigger: HTMLElement) {
		sessionActionsSession = session;
		sessionActionError = '';
		sessionActionsTrigger = trigger;
	}

	function closeSessionActions(restoreFocus = true) {
		const trigger = sessionActionsTrigger;
		sessionActionsSession = undefined;
		sessionActionsTrigger = undefined;
		if (restoreFocus) void tick().then(() => trigger?.focus());
	}

	function handleOverlayKeydown(event: KeyboardEvent) {
		if (event.key !== 'Escape') return;
		if (sessionActionsSession) {
			event.preventDefault();
			closeSessionActions();
		} else if (mobileSessionsOpen && (activeSession || requestedSessionId)) {
			event.preventDefault();
			closeSessionNavigator();
		}
	}

	function syncSessionFromLocation() {
		const match = /^\/sessions\/([^/]+)\/?$/.exec(location.pathname);
		requestedSessionId = match ? decodeURIComponent(match[1]) : undefined;
		activeSession = requestedSessionId
			? sessions.find((session) => session.id === requestedSessionId)
			: undefined;
		mobileSessionsOpen = !requestedSessionId;
		sessionActionError = '';
	}

	async function restartSession(session: ManagedSession) {
		sessionAction = 'restart';
		sessionActionError = '';
		try {
			const data = await request<{ session: ManagedSession }>(`/api/sessions/${encodeURIComponent(session.id)}`, {
				method: 'POST'
			});
			sessionsRequestVersion += 1;
			sessions = sessions.map((item) => item.id === data.session.id ? data.session : item);
			activeSession = data.session;
			void refreshSessions({ quiet: true });
		} catch (error) {
			sessionActionError = error instanceof Error ? error.message : 'Unable to restart the session';
		} finally {
			sessionAction = undefined;
		}
	}

	async function closeSession(session: ManagedSession) {
		sessionAction = 'close';
		sessionActionError = '';
		try {
			await request<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(session.id)}/close`, { method: 'POST' });
			sessionsRequestVersion += 1;
			sessions = sessions.map((item) => item.id === session.id
				? { ...item, state: 'missing', lastOutputAt: null, attachedClients: 0, foregroundProcess: null }
				: item);
			if (activeOutputSessionId === session.id) activeOutputSessionId = undefined;
			closeSessionActions(false);
			if (activeSession?.id === session.id || requestedSessionId === session.id) clearActiveSession();
			void refreshSessions({ quiet: true });
		} catch (error) {
			sessionActionError = error instanceof Error ? error.message : 'Unable to close the session';
		} finally {
			sessionAction = undefined;
		}
	}

	async function removeSession(session: ManagedSession) {
		sessionAction = 'remove';
		sessionActionError = '';
		try {
			await request<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(session.id)}`, { method: 'DELETE' });
			sessionsRequestVersion += 1;
			sessions = sessions.filter((item) => item.id !== session.id);
			manualSessionOrder = manualSessionOrder.filter((id) => id !== session.id);
			persistManualSessionOrder();
			closeSessionActions(false);
			if (activeSession?.id === session.id || requestedSessionId === session.id) clearActiveSession();
		} catch (error) {
			sessionActionError = error instanceof Error ? error.message : 'Unable to remove the workspace';
		} finally {
			sessionAction = undefined;
		}
	}

	onMount(() => {
		let disposed = false;
		transportSecure = location.protocol === 'https:' || ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname);
		useMetaSessionShortcuts = /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
		sessionShortcutModifier = useMetaSessionShortcuts ? '⌘' : 'Ctrl+';
		const savedOrderMode = window.localStorage.getItem('vampire:session-order-mode');
		if (savedOrderMode === 'recent' || savedOrderMode === 'manual') sessionOrderMode = savedOrderMode;
		try {
			const savedOrder: unknown = JSON.parse(window.localStorage.getItem('vampire:session-order') ?? '[]');
			if (Array.isArray(savedOrder) && savedOrder.every((id) => typeof id === 'string')) manualSessionOrder = savedOrder;
		} catch {
			manualSessionOrder = [];
		}

		void (async () => {
			try {
				const status = await request<{ authenticationRequired: boolean; authenticated: boolean; tmux: TmuxStatus }>('/api/status');
				if (disposed) return;
				authenticationRequired = status.authenticationRequired;
				authenticated = status.authenticated;
				tmuxStatus = status.tmux;
				if (authenticated) await refreshSessions();
			} catch (error) {
				errorMessage = error instanceof Error ? error.message : 'Unable to connect to Vampire';
			} finally {
				if (!disposed) checking = false;
			}
		})();

		const refreshWhenVisible = () => {
			if (!document.hidden && authenticated) void refreshSessions({ quiet: true });
		};
		const interval = window.setInterval(refreshWhenVisible, 2_000);
		document.addEventListener('visibilitychange', refreshWhenVisible);
		window.addEventListener('popstate', syncSessionFromLocation);
		window.addEventListener('keydown', handleSessionShortcut, { capture: true });
		window.addEventListener('keydown', handleOverlayKeydown, { capture: true });
		if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => undefined);

		return () => {
			disposed = true;
			window.clearInterval(interval);
			for (const timer of activityRequestTimers.values()) window.clearTimeout(timer);
			activityRequestTimers.clear();
			document.removeEventListener('visibilitychange', refreshWhenVisible);
			window.removeEventListener('popstate', syncSessionFromLocation);
			window.removeEventListener('keydown', handleSessionShortcut, { capture: true });
			window.removeEventListener('keydown', handleOverlayKeydown, { capture: true });
		};
	});
</script>

	<svelte:head>
	<meta name="description" content="A self-hosted browser workspace for persistent tmux sessions." />
</svelte:head>

<main class:terminal-open={Boolean(activeSession || requestedSessionId)} class:tmux-missing={tmuxStatus?.available === false}>
	{#if checking}
		<section class="loading-state" aria-live="polite">
			<span class="spinner" aria-hidden="true"></span>
			Connecting…
		</section>
	{:else if authenticationRequired && !authenticated}
		{#if tmuxStatus && !tmuxStatus.available}<TmuxSetupNotice status={tmuxStatus} />{/if}
		<section class="login-panel" aria-labelledby="login-title">
			<p class="section-label">Private server</p>
			<h1 id="login-title">Connect to Vampire</h1>
			<p class="supporting">Enter the access token configured on this computer.</p>
			{#if !transportSecure}<p class="transport-warning" role="alert">This connection is not encrypted. Use HTTPS before entering a token.</p>{/if}
			<form onsubmit={(event) => { event.preventDefault(); void unlock(); }}>
				<label for="token">Access token</label>
				<input id="token" type="password" bind:value={token} autocomplete="current-password" required />
				<button class="primary-button">Continue</button>
				{#if loginError}<p class="error" role="alert">{loginError}</p>{/if}
			</form>
		</section>
	{:else}
		{#if tmuxStatus && !tmuxStatus.available}<TmuxSetupNotice status={tmuxStatus} />{/if}
		<div
			class="dashboard"
			class:terminal-open={Boolean(activeSession || requestedSessionId)}
		>
			<SessionNavigator
				{sessions}
				{displayedSessions}
				activeSessionId={activeSession?.id}
				{activeOutputSessionId}
				{authenticationRequired}
				hasOpenSession={Boolean(activeSession || requestedSessionId)}
				mobileOpen={mobileSessionsOpen}
				{loading}
				{errorMessage}
				{sessionOrderMode}
				bind:newSessionOpen
				bind:cwd
				{starting}
				{startError}
				tmuxAvailable={tmuxStatus?.available}
				onRefresh={() => void refreshSessions()}
				onLogout={() => void logout()}
				onClose={closeSessionNavigator}
				onOrderModeChange={setSessionOrderMode}
				onReorder={reorderSession}
				onOpen={openSession}
				onOpenActions={openSessionActions}
				onCreate={() => void createSession()}
			/>

			{#if activeSession?.state === 'missing'}
				<section class="unavailable-sheet" aria-labelledby="ended-session-title">
					<header class="unavailable-header">
						<button class="detail-back" onclick={openSessionNavigator} aria-label="Open workspaces">
							<PanelLeft size={18} strokeWidth={1.8} aria-hidden="true" />
							<span>Workspaces</span>
						</button>
						<div class="unavailable-identity">
							<strong>{projectName(activeSession.cwd)}</strong>
							<span title={activeSession.cwd}>{activeSession.cwd}</span>
						</div>
						<span class="ended-badge">Ended</span>
					</header>
					<div class="unavailable-body">
						<span class="unavailable-icon" aria-hidden="true"><SquareTerminal size={22} strokeWidth={1.7} /></span>
						<p class="section-label">tmux session unavailable</p>
						<h2 id="ended-session-title">This shell has ended</h2>
						<p>The process is no longer running. You can open a fresh shell in the same project or remove this workspace from the list.</p>
						<code>{activeSession.cwd}</code>
						<div class="unavailable-actions">
							<button class="primary-button" onclick={() => void restartSession(activeSession!)} disabled={Boolean(sessionAction)}>
								{sessionAction === 'restart' ? 'Reopening…' : 'Reopen shell'}
							</button>
							<button class="remove-button" onclick={() => void removeSession(activeSession!)} disabled={Boolean(sessionAction)}>
								{sessionAction === 'remove' ? 'Removing…' : 'Remove workspace'}
							</button>
						</div>
						{#if sessionActionError}<p class="error" role="alert">{sessionActionError}</p>{/if}
					</div>
				</section>
			{:else if activeSession}
				{#key activeSession.id}
					<WorkspaceWorkbench
						session={activeSession}
						close={openSessionNavigator}
						onUpdateNote={updateSessionNote}
						onInputActivity={recordSessionInput}
						onOutputActivity={recordSessionOutput}
					/>
				{/key}
			{:else if requestedSessionId && sessionsLoaded}
				<section class="unavailable-sheet" aria-labelledby="missing-session-title">
					<header class="unavailable-header">
						<button class="detail-back" onclick={openSessionNavigator} aria-label="Open workspaces">
							<PanelLeft size={18} strokeWidth={1.8} aria-hidden="true" />
							<span>Workspaces</span>
						</button>
					</header>
					<div class="unavailable-body">
						<span class="unavailable-icon" aria-hidden="true"><CircleHelp size={22} strokeWidth={1.7} /></span>
						<h2 id="missing-session-title">Workspace not found</h2>
						<p>This workspace is no longer registered on this Vampire server.</p>
						<button class="secondary-button" onclick={openSessionNavigator}>Open workspaces</button>
					</div>
				</section>
			{:else}
				<section class="empty-workbench" aria-labelledby="empty-workbench-title">
					<span class="empty-workbench__prompt" aria-hidden="true"><SquareTerminal size={26} strokeWidth={1.5} /></span>
					<h2 id="empty-workbench-title">Select a workspace</h2>
					<p>Choose a workspace from the sidebar or start a new one.</p>
					<p class="empty-workbench__shortcut"><Keyboard size={14} strokeWidth={1.7} aria-hidden="true" /> {sessionShortcutModifier}1–0 · Alt+1–0</p>
				</section>
			{/if}
		</div>

		{#if sessionActionsSession}
			<SessionActionsDialog
				session={sessionActionsSession}
				action={sessionAction}
				errorMessage={sessionActionError}
				close={() => closeSessionActions()}
				closeSession={closeSession}
				remove={removeSession}
			/>
		{/if}
	{/if}
</main>

<style>
	main {
		width: 100%;
		min-height: 100dvh;
	}

	.dashboard { min-width: 0; min-height: 100dvh; padding: max(1rem, env(safe-area-inset-top)) 1rem max(1rem, env(safe-area-inset-bottom)); }
	.login-panel { border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-surface); }
	.login-panel h1 { margin: 0.15rem 0 0; font-size: var(--text-display); font-weight: var(--weight-strong); line-height: var(--leading-tight); }
	.section-label { margin: 0; color: var(--color-text-tertiary); font-size: var(--text-caption); font-weight: var(--weight-medium); line-height: var(--leading-ui); }
	form { display: grid; gap: 0.7rem; }
	label { color: var(--color-text); font-size: var(--text-label); font-weight: var(--weight-medium); }
	input { width: 100%; min-width: 0; min-height: 2.9rem; padding: 0 0.8rem; border: 1px solid var(--color-border-strong); border-radius: var(--radius-sm); background: #111011; color: var(--color-text); font-size: var(--text-body); }
	input::placeholder { color: #665f61; }
	.primary-button, .secondary-button { min-height: 2.85rem; padding: 0 1rem; border: 0; border-radius: var(--radius-sm); font-size: var(--text-label); font-weight: var(--weight-medium); cursor: pointer; }
	.primary-button { background: var(--color-accent); color: var(--color-accent-ink); }
	.primary-button:hover { background: var(--color-accent-hover); }
	.primary-button:disabled { cursor: wait; opacity: 0.65; }
	.secondary-button { background: var(--color-surface-raised); color: var(--color-text); }
	.login-panel { width: min(calc(100% - 2rem), 25rem); margin: clamp(2rem, 12vh, 7rem) auto; padding: 1.5rem; }
	.login-panel .supporting { margin: 0.7rem 0 1.4rem; color: var(--color-text-secondary); font-size: var(--text-body); line-height: var(--leading-body); }
	.transport-warning { margin: -0.65rem 0 1.25rem; padding: 0.7rem 0.8rem; border: 1px solid #704047; border-radius: var(--radius-sm); background: #2b171b; color: #ffb5bb; font-size: var(--text-label); line-height: var(--leading-ui); }
	.login-panel form { gap: 0.8rem; }
	.error { margin: 0; color: var(--color-danger); font-size: var(--text-label); line-height: var(--leading-ui); }
	.loading-state { display: flex; align-items: center; justify-content: center; gap: 0.7rem; min-height: 100dvh; color: var(--color-text-secondary); }
	.spinner { width: 1rem; height: 1rem; border: 2px solid var(--color-border-strong); border-top-color: var(--color-accent); border-radius: 50%; animation: spin 0.8s linear infinite; }

	.unavailable-sheet { position: fixed; z-index: 20; inset: 0; display: grid; grid-template-rows: auto minmax(0, 1fr); overflow: hidden; background: #0d0c0d; color: var(--color-text); }
	.unavailable-header { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 0.75rem; min-width: 0; padding: max(0.65rem, env(safe-area-inset-top)) max(0.75rem, env(safe-area-inset-right)) 0.65rem max(0.75rem, env(safe-area-inset-left)); border-bottom: 1px solid #2d292a; background: #131112; }
	.detail-back { display: inline-flex; align-items: center; gap: 0.25rem; min-height: 2.65rem; padding: 0 0.65rem 0 0.45rem; border: 1px solid #393334; border-radius: 0.55rem; background: #1c191a; color: var(--color-text); font: inherit; font-weight: var(--weight-medium); cursor: pointer; }
	.detail-back:hover { background: #282324; }
	.unavailable-identity { display: grid; min-width: 0; justify-items: center; gap: 0.18rem; }
	.unavailable-identity strong, .unavailable-identity span { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.unavailable-identity strong { font-size: var(--text-body); font-weight: var(--weight-medium); }
	.unavailable-identity span { color: var(--color-text-tertiary); font-family: ui-monospace, monospace; font-size: var(--text-caption); }
	.ended-badge { padding: 0.28rem 0.5rem; border-radius: 999px; background: #332d2e; color: var(--color-text-secondary); font-size: var(--text-caption); font-weight: var(--weight-medium); }
	.unavailable-body { display: flex; flex-direction: column; align-items: flex-start; justify-content: center; width: min(100%, 32rem); min-height: 0; margin: 0 auto; padding: 2rem 1.25rem max(2rem, env(safe-area-inset-bottom)); }
	.unavailable-icon { display: grid; place-items: center; width: 3rem; height: 3rem; margin-bottom: 1.25rem; border: 1px solid #393334; border-radius: 0.8rem; background: #171415; color: var(--color-accent); }
	.unavailable-body h2 { margin: 0.3rem 0 0; font-size: var(--text-display); font-weight: var(--weight-strong); line-height: var(--leading-tight); }
	.unavailable-body > p:not(.section-label):not(.error) { margin: 0.75rem 0 1rem; overflow-wrap: anywhere; color: var(--color-text-secondary); font-size: var(--text-body); line-height: var(--leading-body); }
	.unavailable-body code { display: block; width: 100%; overflow: hidden; margin-bottom: 1.25rem; padding: 0.75rem; border: 1px solid #302b2c; border-radius: 0.55rem; background: #131112; color: var(--color-text-secondary); font-size: var(--text-caption); text-overflow: ellipsis; white-space: nowrap; }
	.unavailable-actions { display: flex; flex-wrap: wrap; gap: 0.65rem; width: 100%; }
	.unavailable-actions button { flex: 1 1 10rem; }
	.remove-button { min-height: 2.85rem; padding: 0 1rem; border: 1px solid #4a3d40; border-radius: var(--radius-sm); background: transparent; color: #e9a3aa; font-size: var(--text-label); font-weight: var(--weight-medium); cursor: pointer; }
	.remove-button:hover { background: #27191c; }
	.remove-button:disabled { cursor: wait; opacity: 0.6; }
	.unavailable-body .error { margin-top: 0.9rem; }
	.empty-workbench { display: none; }

	@keyframes spin { to { transform: rotate(360deg); } }

	@media (min-width: 64rem) {
		main { height: 100dvh; overflow: hidden; }
		main.tmux-missing { display: grid; grid-template-rows: auto minmax(0, 1fr); }
		main.tmux-missing .dashboard { min-height: 0; }
		.dashboard { display: grid; grid-template-columns: 20rem minmax(0, 1fr); align-items: stretch; gap: 0; height: 100%; min-height: 0; padding: 0; }
		.empty-workbench { display: flex; flex-direction: column; align-items: center; justify-content: center; min-width: 0; background: #0d0c0d; color: var(--color-text-tertiary); }
		.empty-workbench__prompt { margin-bottom: 0.9rem; color: #4d4547; }
		.empty-workbench h2 { margin: 0; color: #8e8688; font-size: var(--text-title); font-weight: var(--weight-medium); line-height: var(--leading-tight); }
		.empty-workbench p { margin: 0.45rem 0 0; font-size: var(--text-caption); }
		.empty-workbench .empty-workbench__shortcut { display: flex; align-items: center; gap: 0.4rem; margin-top: 0.9rem; color: #5f5759; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--text-caption); }
		.unavailable-sheet { position: relative; z-index: 1; inset: auto; height: 100dvh; min-height: 0; border: 0; border-radius: 0; }
	}

	@media (max-width: 32rem) {
		.unavailable-header { grid-template-columns: 2.65rem minmax(0, 1fr) auto; }
		.detail-back { width: 2.65rem; padding: 0; justify-content: center; }
		.detail-back span { display: none; }
		input { font-size: 1rem; }
	}

	@media (prefers-reduced-motion: reduce) {
		.spinner { animation-duration: 1.6s; }
	}
</style>
