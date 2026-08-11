import { execFile } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test, type Locator, type Page, type WebSocketRoute } from '@playwright/test';
import {
	authenticate,
	createSession,
	E2E_WORKSPACE_DIRECTORY,
	expectTerminalReady,
	removeSession,
	resetSessions
} from './support.ts';

declare global {
	interface Window {
		__vampireObservedWorkspaceStates: string[];
		__vampireWorkspaceStateTimer: number;
	}
}

let sessionId: string | undefined;
const run = promisify(execFile);

async function gitWorkspace(...args: string[]): Promise<void> {
	await run('git', ['-C', E2E_WORKSPACE_DIRECTORY, ...args], {
		env: {
			...process.env,
			GIT_AUTHOR_NAME: 'Vampire E2E',
			GIT_AUTHOR_EMAIL: 'vampire-e2e@example.test',
			GIT_COMMITTER_NAME: 'Vampire E2E',
			GIT_COMMITTER_EMAIL: 'vampire-e2e@example.test'
		}
	});
}

async function tmuxPaneGeometry(tmuxSession: string): Promise<{ columns: number; rows: number }> {
	const { stdout } = await run('tmux', [
		'display-message',
		'-p',
		'-t',
		tmuxSession,
		'#{pane_width}\t#{pane_height}'
	]);
	const [columns, rows] = stdout.trim().split('\t').map(Number);
	return { columns, rows };
}

async function tmuxPaneCursor(tmuxSession: string): Promise<{ column: number; row: number }> {
	const { stdout } = await run('tmux', [
		'display-message',
		'-p',
		'-t',
		tmuxSession,
		'#{cursor_x}\t#{cursor_y}'
	]);
	const [column, row] = stdout.trim().split('\t').map(Number);
	return { column, row };
}

async function renderedTerminalGeometry(page: Page): Promise<{
	containerWidth: number;
	rows: number;
	screenWidth: number;
}> {
	return page.getByRole('application', { name: 'Interactive shell terminal' }).evaluate((terminal) => {
		const rows = terminal.querySelector('.xterm-rows');
		const screen = terminal.querySelector<HTMLElement>('.xterm-screen');
		return {
			containerWidth: terminal.getBoundingClientRect().width,
			rows: rows?.childElementCount ?? 0,
			screenWidth: screen?.getBoundingClientRect().width ?? 0
		};
	});
}

function normalizeTerminalRows(rows: string[]): string[] {
	return rows.map((row) => row.replace(/\s+$/u, ''));
}

async function tmuxPaneRows(tmuxSession: string): Promise<string[]> {
	const { stdout } = await run('tmux', ['capture-pane', '-p', '-t', tmuxSession]);
	const rows = stdout.replace(/\r/g, '').split('\n');
	if (rows.at(-1) === '') rows.pop();
	return normalizeTerminalRows(rows);
}

async function renderedTerminalRows(page: Page): Promise<string[]> {
	await page.locator('.xterm-viewport').evaluate((viewport) => {
		viewport.scrollTop = viewport.scrollHeight;
	});
	return normalizeTerminalRows(await page.locator('.xterm-rows > div').allTextContents());
}

function terminalRowsMismatch(expected: string[], rendered: string[], device: number): string {
	const rowCount = Math.max(expected.length, rendered.length);
	for (let index = 0; index < rowCount; index += 1) {
		if (rendered[index] !== expected[index]) {
			return `device ${device}, row ${index + 1}: tmux=${JSON.stringify(expected[index])}, xterm=${JSON.stringify(rendered[index])}`;
		}
	}
	return '';
}

async function expectTerminalRowsMatchTmux(tmuxSession: string, ...pages: Page[]): Promise<void> {
	await expect.poll(async () => {
		const [expected, ...rendered] = await Promise.all([
			tmuxPaneRows(tmuxSession),
			...pages.map(renderedTerminalRows)
		]);
		return rendered.map((rows, index) => terminalRowsMismatch(expected, rows, index + 1))
			.filter(Boolean)
			.join('\n');
	}).toBe('');
	const expected = await tmuxPaneRows(tmuxSession);
	for (const page of pages) expect(await renderedTerminalRows(page)).toEqual(expected);
}

async function activateTerminal(page: Page): Promise<void> {
	await page.getByRole('application', { name: 'Interactive shell terminal' }).evaluate((terminal) => {
		terminal.dispatchEvent(new PointerEvent('pointerdown', {
			bubbles: true,
			cancelable: true,
			pointerType: 'mouse',
			isPrimary: true
		}));
	});
}

async function fillTerminalWithNumberedRows(tmuxSession: string): Promise<void> {
	const command = "clear; i=1; while [ $i -le 300 ]; do printf 'VAMP_ROW_%03d\\n' \"$i\"; i=$((i + 1)); done";
	await run('tmux', ['send-keys', '-t', tmuxSession, '-l', '--', command]);
	await run('tmux', ['send-keys', '-t', tmuxSession, 'Enter']);
	await expect.poll(async () => (await tmuxPaneRows(tmuxSession)).some((row) => row === 'VAMP_ROW_300'))
		.toBe(true);
}

interface ObservedTerminalMessage {
	direction: 'client' | 'server';
	slot?: number;
	type?: string;
}

async function observeTerminalMessages(page: Page, messages: ObservedTerminalMessage[]): Promise<void> {
	await page.routeWebSocket(/\/ws\/terminal(?:\?|$)/, (socket) => {
		const server = socket.connectToServer();
		const record = (direction: ObservedTerminalMessage['direction'], message: string | Buffer) => {
			try {
				const value = JSON.parse(typeof message === 'string' ? message : message.toString()) as {
					slot?: unknown;
					type?: unknown;
				};
				messages.push({
					direction,
					...(typeof value.type === 'string' ? { type: value.type } : {}),
					...(typeof value.slot === 'number' ? { slot: value.slot } : {})
				});
			} catch {
				messages.push({ direction });
			}
		};
		socket.onMessage((message) => {
			record('client', message);
			server.send(message);
		});
		server.onMessage((message) => {
			record('server', message);
			socket.send(message);
		});
	});
}

async function dropWorkspaceEntry(
	target: Locator,
	entry: { path: string; kind: 'file' | 'directory' }
): Promise<void> {
	await target.evaluate((element, value) => {
		const dataTransfer = new DataTransfer();
		dataTransfer.setData('application/x-vampire-workspace-entry', JSON.stringify(value));
		element.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }));
		element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
	}, entry);
}

async function dragWorkspaceEntryOver(
	target: Locator,
	entry: { path: string; kind: 'file' | 'directory' }
): Promise<void> {
	await target.evaluate((element, value) => {
		const dataTransfer = new DataTransfer();
		dataTransfer.setData('application/x-vampire-workspace-entry', JSON.stringify(value));
		element.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }));
	}, entry);
}

function reportedThemeAfterLatestRequest(messages: ObservedTerminalMessage[]): boolean {
	const requestIndex = messages.findLastIndex(
		(message) => message.direction === 'server' && message.type === 'request-terminal-theme'
	);
	if (requestIndex < 0) return false;
	const reports = messages.slice(requestIndex + 1).filter(
		(message) => message.direction === 'client' && message.type === 'terminal-color'
	);
	return reports.some((message) => message.slot === 10) && reports.some((message) => message.slot === 11);
}

test.beforeEach(async ({ request }) => {
	sessionId = undefined;
	await resetSessions(request);
});

test.afterEach(async ({ context }) => {
	await removeSession(context, sessionId);
	sessionId = undefined;
});

test('rejects a wrong token and unlocks without waiting for the workspace stream', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByLabel('Access token')).toBeVisible();

	await page.getByLabel('Access token').fill('wrong-token');
	await page.getByRole('button', { name: 'Continue' }).click();
	await expect(page.getByRole('alert')).toContainText('That access token did not work.');

	await page.routeWebSocket(/\/ws\/workspace(?:\?|$)/, () => undefined);
	await page.getByLabel('Access token').fill('vampire-playwright-token');
	await page.getByRole('button', { name: 'Continue' }).click();
	await expect(page.getByRole('heading', { name: 'Workspaces', exact: true })).toBeVisible();
});

test('inspects listening ports as an on-demand system utility', async ({ context, page }) => {
	await authenticate(context);
	const session = await createSession(context);
	sessionId = session.id;
	await page.route('**/api/system/ports', async (route) => {
		await route.fulfill({
			json: {
				ports: [
					{
						protocol: 'tcp',
						port: 5173,
						addresses: ['127.0.0.1', '::1'],
						pid: 321,
						processName: 'node',
						cwd: '/projects/site',
						termination: 'available'
					},
					{
						protocol: 'tcp',
						port: 7678,
						addresses: ['127.0.0.1'],
						pid: 999,
						processName: 'node',
						cwd: '/projects/vampire',
						termination: 'protected'
					}
				]
			}
		});
	});

	await page.goto(`/sessions/${encodeURIComponent(session.id)}`);
	await expectTerminalReady(page);
	const systemMetrics = page.locator('.terminal-header .system-metrics');
	await expect(systemMetrics).toBeVisible();
	await expect(systemMetrics.locator('.system-metric').first().locator('output')).toContainText('≈');
	await expect(systemMetrics.locator('.system-metric').first()).toHaveAttribute(
		'title',
		/sampled average across all logical cores; refreshes about every 2 seconds/i
	);
	await expect(page.getByRole('button', { name: 'Inspect listening ports' })).toBeVisible();
	await page.getByRole('button', { name: 'Inspect listening ports' }).click();
	await expect(page.getByRole('heading', { name: 'Listening ports' })).toBeVisible();
	await expect(page.getByText('2 ports')).toBeVisible();
	const developmentServer = page.locator('.listening-port-row', { hasText: '5173' });
	await expect(developmentServer).toContainText('Localhost');
	await expect(developmentServer).toContainText('/projects/site');
	const filter = page.getByRole('searchbox', { name: 'Filter listening ports' });
	await filter.fill('vampire');
	await expect(developmentServer).toBeHidden();
	await filter.clear();
	await page.getByRole('button', { name: 'Stop node on port 5173' }).click();
	await expect(page.getByRole('heading', { name: 'Stop node?' })).toBeVisible();
	await expect(page.getByText('This closes port 5173 and any other work owned by that process.')).toBeVisible();
	await page.getByRole('button', { name: 'Cancel' }).click();

	const vampireServer = page.locator('.listening-port-row', { hasText: '7678' });
	await expect(vampireServer).toContainText('Protected');
	await expect(vampireServer.getByRole('button', { name: /Stop/ })).toHaveCount(0);
});

test('reconnects the terminal after a transient WebSocket close', async ({ context, page }) => {
	await authenticate(context);
	const session = await createSession(context);
	sessionId = session.id;

	let firstConnection: WebSocketRoute | undefined;
	let resolveFirstConnection!: () => void;
	let resolveSecondConnection!: () => void;
	const firstConnectionOpened = new Promise<void>((resolve) => { resolveFirstConnection = resolve; });
	const secondConnectionOpened = new Promise<void>((resolve) => { resolveSecondConnection = resolve; });
	let connectionCount = 0;
	await page.routeWebSocket(/\/ws\/terminal(?:\?|$)/, (socket) => {
		socket.connectToServer();
		connectionCount += 1;
		if (connectionCount === 1) {
			firstConnection = socket;
			resolveFirstConnection();
		} else if (connectionCount === 2) {
			resolveSecondConnection();
		}
	});

	await page.goto(`/sessions/${encodeURIComponent(session.id)}`);
	await firstConnectionOpened;
	await expectTerminalReady(page);
	await firstConnection!.close({ code: 1012, reason: 'browser test restart' });

	await expect(page.locator('.terminal-connection-status')).toContainText('Reconnecting to terminal…');
	await secondConnectionOpened;
	await expect(page.getByText('Reconnecting to terminal…')).toBeHidden({ timeout: 15_000 });
	await expectTerminalReady(page);
	expect(connectionCount).toBe(2);
});

test('keeps geometry messages away from a pre-geometry browser tab', async ({ context, page }) => {
	await authenticate(context);
	const session = await createSession(context);
	sessionId = session.id;
	await page.goto('/');

	const messageTypes = await page.evaluate(({ id, terminalId }) => new Promise<string[]>((resolve, reject) => {
		const url = new URL('/ws/terminal', location.href);
		url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		url.searchParams.set('session', id);
		if (terminalId) url.searchParams.set('terminal', terminalId);
		const socket = new WebSocket(url);
		const types: string[] = [];
		const timer = window.setTimeout(() => {
			socket.close();
			reject(new Error('legacy terminal connection timed out'));
		}, 10_000);
		socket.onmessage = (event) => {
			const message = JSON.parse(String(event.data)) as { type?: string };
			if (typeof message.type === 'string') types.push(message.type);
			if (message.type === 'snapshot') socket.send(JSON.stringify({ type: 'snapshot-ready' }));
			if (message.type !== 'screen-ready') return;
			window.clearTimeout(timer);
			socket.close();
			resolve(types);
		};
		socket.onerror = () => {
			window.clearTimeout(timer);
			reject(new Error('legacy terminal connection failed'));
		};
	}), { id: session.id, terminalId: session.terminals[0]?.id });

	expect(messageTypes).toContain('snapshot');
	expect(messageTypes).toContain('screen-ready');
	expect(messageTypes).not.toContain('geometry');
});

test('ignores transient terminal container collapse until a usable size returns', async ({ context, page }) => {
	await authenticate(context);
	const session = await createSession(context);
	sessionId = session.id;

	await page.goto(`/sessions/${encodeURIComponent(session.id)}`);
	await expectTerminalReady(page);
	const terminal = page.getByRole('application', { name: 'Interactive shell terminal' });
	const visibleRows = await terminal.locator('.xterm-rows').evaluate((rows) => rows.childElementCount);
	expect(visibleRows).toBeGreaterThanOrEqual(5);

	await terminal.evaluate((element) => {
		element.style.width = '1px';
		element.style.height = '1px';
	});
	await page.waitForTimeout(250);
	expect(await terminal.locator('.xterm-rows').evaluate((rows) => rows.childElementCount)).toBe(visibleRows);

	await terminal.evaluate((element) => {
		element.style.removeProperty('width');
		element.style.removeProperty('height');
	});
	await run('tmux', ['send-keys', '-t', session.tmuxSession, '-l', '--', "printf 'stable-terminal-size\\n'"]);
	await run('tmux', ['send-keys', '-t', session.tmuxSession, 'Enter']);
	await expect(terminal.locator('.xterm-rows')).toContainText('stable-terminal-size');
});

test('keeps the desktop font default on a wide touch display', async ({ browser }) => {
	const context = await browser.newContext({
		viewport: { width: 1280, height: 800 },
		hasTouch: true
	});
	let createdSessionId: string | undefined;
	try {
		await authenticate(context);
		const session = await createSession(context);
		createdSessionId = session.id;
		const page = await context.newPage();
		await page.goto(`/sessions/${encodeURIComponent(session.id)}`);
		await expectTerminalReady(page);
		const fontSize = await page
			.getByRole('application', { name: 'Interactive shell terminal' })
			.locator('.xterm-rows')
			.evaluate((rows) => getComputedStyle(rows).fontSize);
		expect(fontSize).toBe('14px');
	} finally {
		await removeSession(context, createdSessionId);
		await context.close();
	}
});

test('does not treat another device terminal redraw as main-session output', async ({ browser }) => {
	test.setTimeout(60_000);
	const firstContext = await browser.newContext();
	const secondContext = await browser.newContext();
	let createdSession: Awaited<ReturnType<typeof createSession>> | undefined;
	try {
		await authenticate(firstContext);
		await authenticate(secondContext);
		createdSession = await createSession(firstContext);
		const firstPage = await firstContext.newPage();
		const secondPage = await secondContext.newPage();

		await firstPage.goto(`/sessions/${encodeURIComponent(createdSession.id)}`);
		await expectTerminalReady(firstPage);
		await expect(firstPage.locator('.session-row-shell.selected .workspace-state')).toHaveCount(0);
		await firstPage.getByRole('button', { name: 'Arrange workspaces manually' }).click();
		const firstState = firstPage.locator('.session-row-shell.selected .workspace-state');
		await expect(firstState).toHaveText('Idle');
		await firstPage.evaluate(() => {
			window.__vampireObservedWorkspaceStates = [];
			window.__vampireWorkspaceStateTimer = window.setInterval(() => {
				const state = document.querySelector('.session-row-shell.selected .workspace-state')?.textContent?.trim();
				if (state) window.__vampireObservedWorkspaceStates.push(state);
			}, 40);
		});

		await secondPage.goto(`/sessions/${encodeURIComponent(createdSession.id)}`);
		await expectTerminalReady(secondPage);
		await firstPage.waitForTimeout(2_000);
		const observedStates = await firstPage.evaluate(() => {
			window.clearInterval(window.__vampireWorkspaceStateTimer);
			return window.__vampireObservedWorkspaceStates;
		});
		expect(observedStates).not.toContain('Working');
		expect(observedStates).not.toContain('Review');

		await firstPage.goto('/');
		const workspaceState = firstPage.locator('.session-row', { hasText: 'workspace' }).locator('.workspace-state');
		await expect(workspaceState).toHaveText('Idle');
		await firstPage.waitForTimeout(8_200);
		await expect(workspaceState).toHaveText('Idle');
	} finally {
		await removeSession(firstContext, createdSession?.id);
		await Promise.all([firstContext.close(), secondContext.close()]);
	}
});

test('publishes output sent immediately after terminal resize to other devices', async ({ browser }) => {
	test.setTimeout(45_000);
	const observerContext = await browser.newContext();
	const controllerContext = await browser.newContext();
	let createdSession: Awaited<ReturnType<typeof createSession>> | undefined;
	try {
		await authenticate(observerContext);
		await authenticate(controllerContext);
		createdSession = await createSession(observerContext);
		const observerPage = await observerContext.newPage();
		const controllerPage = await controllerContext.newPage();

		await observerPage.goto('/');
		await observerPage.getByRole('button', { name: 'Arrange workspaces manually' }).click();
		const observerState = observerPage.locator('.session-row', { hasText: 'workspace' }).locator('.workspace-state');
		await expect(observerState).toHaveText('Idle');

		await controllerPage.goto(`/sessions/${encodeURIComponent(createdSession.id)}`);
		await expectTerminalReady(controllerPage);
		const composer = controllerPage.getByPlaceholder('Send to shell…');
		await composer.fill("printf 'immediate-resize-output\\n'");
		await composer.press('Enter');

		await expect(observerState).toHaveText('Working', { timeout: 3_000 });
	} finally {
		await removeSession(observerContext, createdSession?.id);
		await Promise.all([observerContext.close(), controllerContext.close()]);
	}
});

test('restores a pending-autowrap cursor before the next terminal character', async ({ browser }) => {
	test.setTimeout(45_000);
	const firstContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
	const secondContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
	let createdSession: Awaited<ReturnType<typeof createSession>> | undefined;
	try {
		await authenticate(firstContext);
		await authenticate(secondContext);
		createdSession = await createSession(firstContext);
		const firstPage = await firstContext.newPage();
		const secondPage = await secondContext.newPage();
		await firstPage.goto(`/sessions/${encodeURIComponent(createdSession.id)}`);
		await expectTerminalReady(firstPage);
		const geometry = await tmuxPaneGeometry(createdSession.tmuxSession);
		const fullRow = 'W'.repeat(geometry.columns);
		const firstComposer = firstPage.getByPlaceholder('Send to shell…');
		await firstComposer.fill(
			`printf '${fullRow}'; IFS= read -r value; printf '\\nVAMP_WRAP_INPUT=%s\\n' "$value"`
		);
		await firstComposer.press('Enter');
		await expect.poll(() => tmuxPaneCursor(createdSession!.tmuxSession))
			.toMatchObject({ column: geometry.columns });

		await secondPage.goto(`/sessions/${encodeURIComponent(createdSession.id)}`);
		await expectTerminalReady(secondPage);
		await expect.poll(() => tmuxPaneGeometry(createdSession!.tmuxSession)).toEqual(geometry);
		await expectTerminalRowsMatchTmux(createdSession.tmuxSession, firstPage, secondPage);
		const secondComposer = secondPage.getByPlaceholder('Send to shell…');
		await secondComposer.fill('Z');
		await secondComposer.press('Enter');
		await expect.poll(async () => (await tmuxPaneRows(createdSession!.tmuxSession))
			.some((row) => row === 'VAMP_WRAP_INPUT=Z')).toBe(true);
		await expectTerminalRowsMatchTmux(createdSession.tmuxSession, firstPage, secondPage);
	} finally {
		await removeSession(firstContext, createdSession?.id);
		await Promise.all([firstContext.close(), secondContext.close()]);
	}
});

test('hands terminal layout between entered devices and restores it on disconnect', async ({ browser }) => {
	test.setTimeout(60_000);
	const desktopContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
	const phoneContext = await browser.newContext({ viewport: { width: 480, height: 560 } });
	let createdSession: Awaited<ReturnType<typeof createSession>> | undefined;
	try {
		await authenticate(desktopContext);
		await authenticate(phoneContext);
		createdSession = await createSession(desktopContext);
		await fillTerminalWithNumberedRows(createdSession.tmuxSession);
		const desktopPage = await desktopContext.newPage();
		const phonePage = await phoneContext.newPage();
		await desktopPage.addInitScript(() => {
			Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true });
		});
		await phonePage.addInitScript(() => {
			Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true });
		});

		await desktopPage.goto(`/sessions/${encodeURIComponent(createdSession.id)}`);
		await expectTerminalReady(desktopPage);
		const desktopRows = await desktopPage.locator('.xterm-rows').evaluate((rows) => rows.childElementCount);
		await expect.poll(async () => (await tmuxPaneGeometry(createdSession!.tmuxSession)).rows).toBe(desktopRows);
		const desktopGeometry = await tmuxPaneGeometry(createdSession.tmuxSession);
		const initialDesktopRender = await renderedTerminalGeometry(desktopPage);
		expect(initialDesktopRender.screenWidth).toBeLessThanOrEqual(initialDesktopRender.containerWidth);
		await expectTerminalRowsMatchTmux(createdSession.tmuxSession, desktopPage);
		const desktopComposer = desktopPage.getByPlaceholder('Send to shell…');
		const alternateScreenCommand = "printf '\\033[?1049h\\033[2J\\033[8;20HVAMP_TUI_READY\\033[12;7H'; IFS= read -r value; printf '\\033[?1049lVAMP_TUI_INPUT=%s\\n' \"$value\"";
		await desktopComposer.fill(alternateScreenCommand);
		await desktopComposer.press('Enter');
		await expect.poll(async () => (await tmuxPaneRows(createdSession!.tmuxSession))
			.some((row) => row.includes('VAMP_TUI_READY'))).toBe(true);
		await expectTerminalRowsMatchTmux(createdSession.tmuxSession, desktopPage);

		await phonePage.goto(`/sessions/${encodeURIComponent(createdSession.id)}`);
		await expectTerminalReady(phonePage);
		await expect.poll(async () => (await tmuxPaneGeometry(createdSession!.tmuxSession)).rows)
			.toBeLessThan(desktopGeometry.rows);
		const phoneGeometry = await tmuxPaneGeometry(createdSession.tmuxSession);
		await expect.poll(() => desktopPage.locator('.xterm-rows').evaluate((rows) => rows.childElementCount))
			.toBe(phoneGeometry.rows);
		await expect.poll(() => renderedTerminalGeometry(phonePage)).toMatchObject({ rows: phoneGeometry.rows });
		const phoneRender = await renderedTerminalGeometry(phonePage);
		expect(phoneRender.screenWidth).toBeLessThanOrEqual(phoneRender.containerWidth);
		await expectTerminalRowsMatchTmux(createdSession.tmuxSession, desktopPage, phonePage);
		const desktopHandoff = desktopPage.getByText('Sized for another device');
		const phoneHandoff = phonePage.getByText('Sized for another device');
		await expect(desktopHandoff).toBeVisible();
		await expect(phoneHandoff).toBeHidden();
		const phoneComposer = phonePage.getByPlaceholder('Send to shell…');
		await phoneComposer.fill('VAMP_TUI_MOBILE_INPUT');
		await phoneComposer.press('Enter');
		await expect.poll(async () => (await tmuxPaneRows(createdSession!.tmuxSession))
			.some((row) => row === 'VAMP_TUI_INPUT=VAMP_TUI_MOBILE_INPUT')).toBe(true);
		await expectTerminalRowsMatchTmux(createdSession.tmuxSession, desktopPage, phonePage);

		await desktopPage.getByRole('button', { name: 'Use this device' }).click();
		await expect.poll(() => tmuxPaneGeometry(createdSession!.tmuxSession)).toEqual(desktopGeometry);
		await expect(desktopHandoff).toBeHidden();
		await expect(phoneHandoff).toBeVisible();
		await expectTerminalRowsMatchTmux(createdSession.tmuxSession, desktopPage, phonePage);

		await phonePage.getByRole('button', { name: 'Use this device' }).click();
		await expect.poll(() => tmuxPaneGeometry(createdSession!.tmuxSession)).toEqual(phoneGeometry);
		await expect(desktopHandoff).toBeVisible();
		await expect(phoneHandoff).toBeHidden();
		await expectTerminalRowsMatchTmux(createdSession.tmuxSession, desktopPage, phonePage);
		await phoneComposer.fill("printf 'VAMP_AFTER_PHONE_HANDOFF\\n'");
		await phoneComposer.press('Enter');
		await expect.poll(async () => (await tmuxPaneRows(createdSession!.tmuxSession))
			.some((row) => row === 'VAMP_AFTER_PHONE_HANDOFF')).toBe(true);
		await expectTerminalRowsMatchTmux(createdSession.tmuxSession, desktopPage, phonePage);

		await phonePage.close();
		await expect.poll(() => tmuxPaneGeometry(createdSession!.tmuxSession)).toEqual(desktopGeometry);
		await expect(desktopHandoff).toBeHidden();
		await expect.poll(() => desktopPage.locator('.xterm-rows').evaluate((rows) => rows.childElementCount))
			.toBe(desktopGeometry.rows);
		const restoredDesktopRender = await renderedTerminalGeometry(desktopPage);
		expect(restoredDesktopRender.screenWidth).toBeLessThanOrEqual(restoredDesktopRender.containerWidth);
		await expectTerminalRowsMatchTmux(createdSession.tmuxSession, desktopPage);
		await desktopComposer.fill("printf 'VAMP_AFTER_DESKTOP_RESTORE\\n'");
		await desktopComposer.press('Enter');
		await expect.poll(async () => (await tmuxPaneRows(createdSession!.tmuxSession))
			.some((row) => row === 'VAMP_AFTER_DESKTOP_RESTORE')).toBe(true);
		await expectTerminalRowsMatchTmux(createdSession.tmuxSession, desktopPage);
	} finally {
		await removeSession(desktopContext, createdSession?.id);
		await Promise.all([desktopContext.close(), phoneContext.close()]);
	}
});

test('re-reports each device theme whenever terminal control changes', async ({ browser }) => {
	test.setTimeout(60_000);
	const firstContext = await browser.newContext();
	const secondContext = await browser.newContext();
	let createdSession: Awaited<ReturnType<typeof createSession>> | undefined;
	try {
		await authenticate(firstContext);
		await authenticate(secondContext);
		createdSession = await createSession(firstContext);
		const firstPage = await firstContext.newPage();
		const secondPage = await secondContext.newPage();
		await firstPage.addInitScript(() => window.localStorage.setItem('vampire:theme', 'light'));
		await secondPage.addInitScript(() => window.localStorage.setItem('vampire:theme', 'dark'));
		const firstMessages: ObservedTerminalMessage[] = [];
		const secondMessages: ObservedTerminalMessage[] = [];
		await observeTerminalMessages(firstPage, firstMessages);
		await observeTerminalMessages(secondPage, secondMessages);

		await firstPage.goto(`/sessions/${encodeURIComponent(createdSession.id)}`);
		await expectTerminalReady(firstPage);
		await expect.poll(() => reportedThemeAfterLatestRequest(firstMessages)).toBe(true);
		const firstRequestCount = firstMessages.filter(
			(message) => message.direction === 'server' && message.type === 'request-terminal-theme'
		).length;

		await secondPage.goto(`/sessions/${encodeURIComponent(createdSession.id)}`);
		await expectTerminalReady(secondPage);
		await expect.poll(() => reportedThemeAfterLatestRequest(secondMessages)).toBe(true);

		await secondPage.close();
		await expect.poll(() => firstMessages.filter(
			(message) => message.direction === 'server' && message.type === 'request-terminal-theme'
		).length).toBe(firstRequestCount + 1);
		await expect.poll(() => reportedThemeAfterLatestRequest(firstMessages)).toBe(true);
	} finally {
		await removeSession(firstContext, createdSession?.id);
		await Promise.all([firstContext.close(), secondContext.close()]);
	}
});

test('runs and stops a background command without replacing the main session', async ({ context, page }) => {
	test.setTimeout(60_000);
	await authenticate(context);
	const session = await createSession(context);
	sessionId = session.id;

	await page.goto(`/sessions/${encodeURIComponent(session.id)}`);
	await expectTerminalReady(page);
	const composer = page.getByPlaceholder('Send to shell…');
	await composer.fill("printf 'main-session-marker\\n'");
	await composer.press('Enter');
	await expect(page.locator('.xterm-rows')).toContainText('main-session-marker');
	const mainWorkspaceProcess = await page.locator('.session-row-shell.selected .session-program').textContent();
	await expect(page.getByRole('tab')).toHaveCount(0);

	await page.getByRole('button', { name: 'Run background command' }).click();
	const backgroundCommand = page.getByRole('textbox', { name: 'Background command' });
	const longCommand = "printf 'background-process-marker\\n'; sleep 30";
	await backgroundCommand.fill(longCommand);
	await page.getByRole('button', { name: 'Run', exact: true }).click();
	const processRow = page.locator('.process-row', { hasText: 'background-process-marker' });
	await expect(processRow).toBeVisible();
	await expect(page.locator('.process-output pre')).toContainText('background-process-marker', { timeout: 10_000 });
	await expect(page.locator('.process-output pre')).toHaveText('background-process-marker');
	await expect(page.locator('.xterm-rows')).toContainText('main-session-marker');
	await expect(page.locator('.xterm-rows')).not.toContainText('background-process-marker');
	await expect(page.locator('.session-row-shell.selected .session-program')).toHaveText(mainWorkspaceProcess || 'zsh');
	await expect(page.locator('.session-row-shell.selected .runtime-summary')).toHaveText('1 background');
	await expect(page.locator('.session-group.idle .session-row-shell.selected')).toBeVisible({ timeout: 12_000 });
	await processRow.getByRole('button', { name: `Save ${longCommand} as favorite`, exact: true }).click();
	await expect(page.getByRole('button', { name: `Run favorite ${longCommand}`, exact: true })).toBeVisible();

	await page.reload();
	await expectTerminalReady(page);
	await page.getByRole('button', { name: 'Run background command' }).click();
	await expect(page.getByRole('button', { name: `Run favorite ${longCommand}`, exact: true })).toBeVisible();
	const outputRoute = '**/api/sessions/*/background/*/output';
	await page.route(outputRoute, async (route) => {
		await new Promise((resolve) => setTimeout(resolve, 2_500));
		await route.continue();
	});
	await composer.fill("for i in {1..24}; do printf 'main-output-churn\\n'; sleep 0.4; done");
	await composer.press('Enter');
	await processRow.locator('.process-summary').click();
	await expect(page.locator('.process-output pre')).toContainText('background-process-marker', { timeout: 10_000 });
	const returnedToLoading = await page.locator('.process-output').evaluate(async (output) => {
		let loadingObserved = Boolean(output.querySelector('.output-placeholder'));
		const observer = new MutationObserver(() => {
			if (output.querySelector('.output-placeholder')) loadingObserved = true;
		});
		observer.observe(output, {
			characterData: true,
			childList: true,
			subtree: true
		});
		await new Promise((resolve) => window.setTimeout(resolve, 4_000));
		observer.disconnect();
		return loadingObserved;
	});
	expect(returnedToLoading).toBe(false);
	await page.unrouteAll({ behavior: 'wait' });

	await processRow.getByRole('button', { name: /Stop printf/ }).click();
	await expect(processRow).toBeHidden();
	await expect(page.locator('.session-row-shell.selected .runtime-summary')).toBeHidden();
	await page.getByRole('button', { name: `Run favorite ${longCommand}`, exact: true }).click();
	await expect(processRow).toBeVisible({ timeout: 15_000 });
	await processRow.getByRole('button', { name: /Stop printf/ }).click();
	await expect(processRow).toBeHidden();
	await page.getByRole('button', { name: `Remove ${longCommand} from favorites`, exact: true }).click();
	await expect(page.getByRole('button', { name: `Run favorite ${longCommand}`, exact: true })).toHaveCount(0);

	await backgroundCommand.fill("printf 'finished-background-marker\\n'");
	await page.getByRole('button', { name: 'Run', exact: true }).click();
	const finishedRows = page.locator('.process-row', { hasText: 'finished-background-marker' });
	await expect(finishedRows).toHaveCount(1);
	const rerunFinishedCommand = finishedRows.first().getByRole('button', { name: /Run printf.*again/ });
	await expect(rerunFinishedCommand).toBeVisible({ timeout: 10_000 });
	await expect(page.locator('.process-output pre')).toContainText('finished-background-marker');
	await rerunFinishedCommand.click();
	await expect(finishedRows).toHaveCount(2, { timeout: 10_000 });

	await page.reload();
	await expectTerminalReady(page);
	await page.getByRole('button', { name: 'Run background command' }).click();
	await expect(page.locator('.favorite-empty')).toBeVisible();
	await expect(page.locator('.favorite-command')).toHaveCount(0);
	while (await finishedRows.count()) {
		const previousCount = await finishedRows.count();
		const deleteButton = finishedRows.first().getByRole('button', { name: /Delete printf/ });
		await expect(deleteButton).toBeEnabled();
		await deleteButton.click();
		await expect(finishedRows).toHaveCount(previousCount - 1);
	}
});

test('moves terminal output through active, review, idle, and ended', async ({ context, page }) => {
	test.setTimeout(45_000);
	await authenticate(context);
	const session = await createSession(context);
	sessionId = session.id;

	await page.goto('/');
	const workspaceRow = page.locator('.session-row', { hasText: 'workspace' });
	await expect(workspaceRow).toBeVisible();
	await expect(workspaceRow.locator('.workspace-state')).toHaveCount(0);
	await page.getByRole('button', { name: 'Arrange workspaces manually' }).click();
	await expect(workspaceRow.locator('.workspace-state')).toHaveText('Idle');
	await page.getByRole('button', { name: 'Group workspaces by status' }).click();
	await expect(workspaceRow.locator('.workspace-state')).toHaveCount(0);
	await page.waitForTimeout(1_100);
	await run('tmux', ['send-keys', '-t', session.tmuxSession, '-l', '--', "printf 'vampire activity check\\n'"]);
	await run('tmux', ['send-keys', '-t', session.tmuxSession, 'Enter']);

	await expect(page.locator('.session-group.working .session-row', { hasText: 'workspace' })).toBeVisible({ timeout: 3_000 });
	await expect(page.locator('.session-group.review .session-row', { hasText: 'workspace' })).toBeVisible({ timeout: 12_000 });
	await page.reload();
	await expect(page.locator('.session-group.review .session-row', { hasText: 'workspace' })).toBeVisible();
	await workspaceRow.click();
	await expectTerminalReady(page);
	await expect(page.locator('.session-group.idle .session-row', { hasText: 'workspace' })).toBeVisible();

	await run('tmux', ['kill-session', '-t', session.tmuxSession]);
	const endedGroup = page.locator('.session-group.ended');
	await expect(endedGroup.getByRole('button', { name: /Ended/ })).toHaveAttribute('aria-expanded', 'true', { timeout: 3_000 });
	await expect(endedGroup.locator('.session-row', { hasText: 'workspace' })).toBeVisible();
});

test('keeps an externally changed file when an editor save conflicts', async ({ context, page }) => {
	test.setTimeout(45_000);
	const conflictFile = join(E2E_WORKSPACE_DIRECTORY, 'conflict.txt');
	await writeFile(conflictFile, 'initial browser test content\n', 'utf8');
	await authenticate(context);
	const session = await createSession(context);
	sessionId = session.id;

	await page.goto(`/sessions/${encodeURIComponent(session.id)}`);
	await expectTerminalReady(page);
	await page.getByRole('button', { name: 'Open repository' }).click();
	await page.getByRole('tab', { name: 'Files' }).click();
	await page.getByRole('button', { name: 'Open conflict.txt' }).click();

	const editor = page.locator('[aria-label="Edit conflict.txt"] .cm-content');
	await expect(editor).toBeVisible({ timeout: 15_000 });
	await editor.click();
	await page.keyboard.press('End');
	await page.keyboard.insertText('\nlocal browser edit');
	await expect(page.getByRole('button', { name: 'Save' })).toBeEnabled();

	await writeFile(conflictFile, 'external process content\n', 'utf8');
	await page.getByRole('button', { name: 'Save' }).click();
	await expect(page.getByRole('alert')).toHaveCount(1);
	await expect(page.locator('.editor-error')).toContainText('This file changed elsewhere. Reload it before saving.');
	expect(await readFile(conflictFile, 'utf8')).toBe('external process content\n');
});

test('adds and moves files through repository menus and drop points', async ({ context, page }) => {
	test.setTimeout(45_000);
	const uploadDirectory = join(E2E_WORKSPACE_DIRECTORY, 'uploads');
	const rootUpload = join(E2E_WORKSPACE_DIRECTORY, 'fresh-upload.bin');
	const renamedConflict = join(E2E_WORKSPACE_DIRECTORY, 'conflict (1).txt');
	const droppedUpload = join(uploadDirectory, 'dropped.txt');
	const movableFile = join(E2E_WORKSPACE_DIRECTORY, 'move-me.txt');
	const movedFile = join(uploadDirectory, 'move-me.txt');
	const moveConflictSource = join(E2E_WORKSPACE_DIRECTORY, 'move-conflict.txt');
	const moveConflictTarget = join(uploadDirectory, 'move-conflict.txt');
	const renamedMoveTarget = join(uploadDirectory, 'move-conflict (1).txt');
	const terminalDroppedFile = join(E2E_WORKSPACE_DIRECTORY, 'terminal-drop.txt');
	await Promise.all([
		rm(uploadDirectory, { recursive: true, force: true }),
		rm(rootUpload, { force: true }),
		rm(renamedConflict, { force: true }),
		rm(terminalDroppedFile, { force: true }),
		writeFile(movableFile, 'move this file\n', 'utf8'),
		writeFile(moveConflictSource, 'move conflict source\n', 'utf8')
	]);
	await writeFile(join(E2E_WORKSPACE_DIRECTORY, 'conflict.txt'), 'initial browser test content\n', 'utf8');

	try {
		await authenticate(context);
		const session = await createSession(context);
		sessionId = session.id;
		await page.goto(`/sessions/${encodeURIComponent(session.id)}`);
		await expectTerminalReady(page);
		await page.getByRole('button', { name: 'Open repository' }).click();

		await page.getByRole('button', { name: 'Add workspace item' }).click();
		await page.getByRole('menuitem', { name: 'New folder' }).click();
		const folderName = page.getByRole('textbox', { name: 'New folder name' });
		await expect(folderName).toBeVisible();
		await folderName.fill('uploads');
		await folderName.press('Enter');
		const folderShell = page.locator('.tree-row-shell.directory').filter({ hasText: 'uploads' }).first();
		const folderRow = folderShell.getByRole('button', { name: 'Expand uploads' });
		await expect(folderRow).toBeVisible();
		await expect(folderRow).toHaveCSS('cursor', 'pointer');
		await folderRow.click({ button: 'right' });
		await expect(page.getByRole('menuitem', { name: 'New file' })).toBeVisible();
		await expect(page.getByRole('menuitem', { name: 'New folder' })).toBeVisible();
		await expect(page.getByRole('menuitem', { name: 'Insert path into terminal' })).toBeVisible();
		await expect(page.getByRole('menuitem', { name: 'Delete' })).toBeVisible();
		await page.keyboard.press('Escape');

		const movableRow = page.getByRole('button', { name: 'Open move-me.txt' });
		const movableShell = movableRow.locator('..');
		await expect(movableShell.getByRole('button', { name: 'Actions for file move-me.txt' })).toHaveCount(1);
		await expect(movableShell.getByRole('button', { name: 'Delete file move-me.txt' })).toHaveCount(0);
		await writeFile(moveConflictTarget, 'existing destination\n', 'utf8');

		await dragWorkspaceEntryOver(folderShell, { path: 'move-me.txt', kind: 'file' });
		await expect(folderShell.getByText('Move here', { exact: true })).toBeVisible();
		await dropWorkspaceEntry(folderShell, { path: 'move-me.txt', kind: 'file' });
		await expect.poll(() => readFile(movedFile, 'utf8').catch(() => '')).toBe('move this file\n');
		await expect.poll(() => readFile(movableFile, 'utf8').then(() => true, () => false)).toBe(false);
		await expect(page.getByRole('button', { name: 'Open uploads/move-me.txt' })).toBeVisible();

		await dropWorkspaceEntry(folderShell, { path: 'move-conflict.txt', kind: 'file' });
		await expect(page.getByRole('heading', { name: 'An item already exists' })).toBeVisible();
		expect(await readFile(moveConflictTarget, 'utf8')).toBe('existing destination\n');
		expect(await readFile(moveConflictSource, 'utf8')).toBe('move conflict source\n');
		await page.getByRole('button', { name: 'Keep both' }).click();
		await expect(page.getByRole('heading', { name: 'An item already exists' })).toBeHidden();
		await expect.poll(() => readFile(renamedMoveTarget, 'utf8').catch(() => '')).toBe('move conflict source\n');
		await expect.poll(() => readFile(moveConflictSource, 'utf8').then(() => true, () => false)).toBe(false);
		expect(await readFile(moveConflictTarget, 'utf8')).toBe('existing destination\n');

		const chooserPromise = page.waitForEvent('filechooser');
		await page.getByRole('button', { name: 'Add workspace item' }).click();
		await page.getByRole('menuitem', { name: 'Choose files…' }).click();
		const chooser = await chooserPromise;
		await chooser.setFiles([
			{ name: 'fresh-upload.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([0, 1, 2, 255]) },
			{ name: 'conflict.txt', mimeType: 'text/plain', buffer: Buffer.from('uploaded conflict\n') }
		]);

		await expect(page.getByRole('heading', { name: '1 file already exists' })).toBeVisible();
		await expect.poll(() => readFile(rootUpload).catch(() => Buffer.alloc(0))).toEqual(Buffer.from([0, 1, 2, 255]));
		expect(await readFile(join(E2E_WORKSPACE_DIRECTORY, 'conflict.txt'), 'utf8')).toBe('initial browser test content\n');
		await page.getByRole('button', { name: 'Keep both' }).click();
		await expect(page.getByRole('heading', { name: '1 file already exists' })).toBeHidden();
		await expect.poll(() => readFile(renamedConflict, 'utf8').catch(() => '')).toBe('uploaded conflict\n');

		await folderShell.evaluate((element) => {
			const dataTransfer = new DataTransfer();
			dataTransfer.items.add(new File(['dropped into folder\n'], 'dropped.txt', { type: 'text/plain' }));
			element.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }));
			element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
		});
		await expect.poll(() => readFile(droppedUpload, 'utf8').catch(() => '')).toBe('dropped into folder\n');
		await expect(folderShell.getByRole('button', { name: 'Collapse uploads' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Open uploads/dropped.txt' })).toBeVisible();
		await expect(page.locator('.repository-upload-notice')).toContainText('Added 1 file.');

		const terminal = page.getByRole('application', { name: 'Interactive shell terminal' });
		await terminal.evaluate((element) => {
			const dataTransfer = new DataTransfer();
			dataTransfer.items.add(new File(['terminal drop content\n'], 'terminal-drop.txt', { type: 'text/plain' }));
			element.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }));
		});
		await expect(page.getByText('Copy to workspace and insert path', { exact: true })).toBeVisible();
		await terminal.evaluate((element) => {
			const dataTransfer = new DataTransfer();
			dataTransfer.items.add(new File(['terminal drop content\n'], 'terminal-drop.txt', { type: 'text/plain' }));
			element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
		});
		await expect.poll(() => readFile(terminalDroppedFile, 'utf8').catch(() => '')).toBe('terminal drop content\n');
		await expect(page.locator('.xterm-rows')).toContainText('terminal-drop.txt');
	} finally {
		await Promise.all([
				rm(uploadDirectory, { recursive: true, force: true }),
				rm(rootUpload, { force: true }),
				rm(renamedConflict, { force: true }),
				rm(terminalDroppedFile, { force: true }),
				rm(movableFile, { force: true }),
				rm(moveConflictSource, { force: true })
			]);
	}
});

test('discards tracked and untracked changes from the Git changes UI', async ({ context, page }) => {
	test.setTimeout(45_000);
	const gitDirectory = join(E2E_WORKSPACE_DIRECTORY, '.git');
	const trackedFile = join(E2E_WORKSPACE_DIRECTORY, 'conflict.txt');
	const untrackedFile = join(E2E_WORKSPACE_DIRECTORY, 'scratch.txt');
	await rm(gitDirectory, { recursive: true, force: true });
	await writeFile(trackedFile, 'committed content\n', 'utf8');
	await gitWorkspace('init', '--quiet');
	await gitWorkspace('add', 'conflict.txt');
	await gitWorkspace('commit', '--quiet', '-m', 'initial');
	await writeFile(trackedFile, 'changed content\n', 'utf8');
	await writeFile(untrackedFile, 'temporary content\n', 'utf8');

	try {
		await authenticate(context);
		const session = await createSession(context);
		sessionId = session.id;
		await page.goto(`/sessions/${encodeURIComponent(session.id)}`);
		await expectTerminalReady(page);
		await page.getByRole('button', { name: 'Open repository' }).click();

		await page.getByRole('button', { name: /Open diff for conflict\.txt/ }).click();
		const viewer = page.getByRole('region', { name: 'Diff for conflict.txt' });
		const editAction = viewer.getByRole('button', { name: 'Edit conflict.txt' });
		await expect(editAction).toBeVisible();
		await expect(editAction).toHaveAttribute('title', 'Edit file');

		await viewer.getByRole('button', { name: 'Discard changes for conflict.txt' }).click();
		await expect(page.getByRole('heading', { name: 'Discard Git changes?' })).toBeVisible();
		await expect(page.getByText('will be restored to its HEAD version')).toBeVisible();
		await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
		await expect.poll(() => readFile(trackedFile, 'utf8')).toBe('committed content\n');
		await expect(viewer).toBeHidden();

		await page.getByRole('button', { name: /Open diff for scratch\.txt/ }).hover();
		await page.getByRole('button', { name: 'Discard changes for scratch.txt' }).click();
		await expect(page.getByRole('heading', { name: 'Delete untracked file?' })).toBeVisible();
		await expect(page.getByText('permanently deletes the file')).toBeVisible();
		await page.getByRole('button', { name: 'Delete file', exact: true }).click();
		await expect.poll(() => readFile(untrackedFile, 'utf8').then(() => true, () => false)).toBe(false);
		await expect(page.getByText('The working tree is clean.')).toBeVisible();
	} finally {
		await rm(gitDirectory, { recursive: true, force: true });
		await rm(untrackedFile, { force: true });
		await writeFile(trackedFile, 'initial browser test content\n', 'utf8');
	}
});

test('does not restart a slow file open while repository status refreshes', async ({ context, page }) => {
	test.setTimeout(45_000);
	const targetFile = join(E2E_WORKSPACE_DIRECTORY, 'slow-open.txt');
	const churnFile = join(E2E_WORKSPACE_DIRECTORY, 'slow-open-churn.txt');
	await writeFile(targetFile, 'slow request content\n', 'utf8');
	let targetRequests = 0;

	try {
		await authenticate(context);
		const session = await createSession(context);
		sessionId = session.id;
		await page.route('**/api/sessions/*/repository/file?*', async (route) => {
			const url = new URL(route.request().url());
			if (url.searchParams.get('path') !== 'slow-open.txt') {
				await route.continue();
				return;
			}
			targetRequests += 1;
			await new Promise((resolve) => setTimeout(resolve, 1_200));
			await route.continue().catch(() => undefined);
		});

		await page.goto(`/sessions/${encodeURIComponent(session.id)}`);
		await expectTerminalReady(page);
		await page.getByRole('button', { name: 'Open repository' }).click();
		await expect(page.getByRole('complementary', { name: 'Repository for workspace' })).toHaveCSS('transition-duration', '0s');
		await expect(page.locator('.workspace-primary')).toHaveCSS('transition-duration', '0s');
		await page.getByRole('tab', { name: 'Files' }).click();
		await page.getByRole('button', { name: 'Open slow-open.txt' }).click();
		const loadingStatus = page.getByRole('status', { name: 'Loading file: slow-open.txt' });
		await expect(loadingStatus).toBeVisible();
		await expect(loadingStatus.locator('.document-opening__spinner')).toBeVisible();
		await expect(loadingStatus.locator('.document-opening__scene')).toHaveCount(0);

		for (let index = 0; index < 4; index += 1) {
			await writeFile(churnFile, `change ${index}\n`, 'utf8');
			await page.waitForTimeout(500);
		}

		await expect(page.locator('[aria-label="Edit slow-open.txt"] .cm-content')).toBeVisible({ timeout: 6_000 });
		expect(targetRequests).toBe(1);
	} finally {
		await Promise.all([
			rm(targetFile, { force: true }),
			rm(churnFile, { force: true })
		]);
	}
});
