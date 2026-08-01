import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test, type WebSocketRoute } from '@playwright/test';
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
