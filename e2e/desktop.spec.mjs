import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import {
	authenticate,
	createSession,
	E2E_WORKSPACE_DIRECTORY,
	expectTerminalReady,
	removeSession
} from './support.mjs';

let sessionId;
const run = promisify(execFile);

test.afterEach(async ({ context }) => {
	await removeSession(context, sessionId);
	sessionId = undefined;
});

	test('rejects a wrong token and unlocks with the configured token', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByLabel('Access token')).toBeVisible();

	await page.getByLabel('Access token').fill('wrong-token');
	await page.getByRole('button', { name: 'Continue' }).click();
	await expect(page.getByRole('alert')).toContainText('That access token did not work.');

	await page.getByLabel('Access token').fill('vampire-playwright-token');
	await page.getByRole('button', { name: 'Continue' }).click();
	await expect(page.getByRole('heading', { name: 'Workspaces', exact: true })).toBeVisible();
});

test('reconnects the terminal after a transient WebSocket close', async ({ context, page }) => {
	await authenticate(context);
	const session = await createSession(context);
	sessionId = session.id;

	let firstConnection;
	let resolveFirstConnection;
	let resolveSecondConnection;
	const firstConnectionOpened = new Promise((resolve) => { resolveFirstConnection = resolve; });
	const secondConnectionOpened = new Promise((resolve) => { resolveSecondConnection = resolve; });
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
	await firstConnection.close({ code: 1012, reason: 'browser test restart' });

	await expect(page.locator('.terminal-connection-status')).toContainText('Reconnecting to terminal…');
	await secondConnectionOpened;
	await expect(page.getByText('Reconnecting to terminal…')).toBeHidden({ timeout: 15_000 });
	await expectTerminalReady(page);
	expect(connectionCount).toBe(2);
});

test('moves terminal output through active, review, idle, and ended', async ({ context, page }) => {
	await authenticate(context);
	const session = await createSession(context);
	sessionId = session.id;

	await page.goto('/');
	const workspaceRow = page.locator('.session-row', { hasText: 'workspace' });
	await expect(workspaceRow).toBeVisible();
	await page.waitForTimeout(1_100);
	await run('tmux', ['send-keys', '-t', session.tmuxSession, '-l', '--', "printf 'vampire activity check\\n'"]);
	await run('tmux', ['send-keys', '-t', session.tmuxSession, 'Enter']);

	await expect(page.locator('.session-group.working').getByRole('heading', { name: /Working/ })).toBeVisible({ timeout: 3_000 });
	await expect(page.locator('.session-group.working').locator('.session-row', { hasText: 'workspace' })).toBeVisible();
	await expect(page.locator('.session-group.review').getByRole('heading', { name: /Review needed/i })).toBeVisible({ timeout: 12_000 });
	await expect(page.locator('.session-group.review').locator('.session-row', { hasText: 'workspace' })).toBeVisible();

	await page.reload();
	await expect(page.locator('.session-group.review').locator('.session-row', { hasText: 'workspace' })).toBeVisible();
	await workspaceRow.click();
	await expectTerminalReady(page);
	await expect(page.locator('.session-group.idle').locator('.session-row', { hasText: 'workspace' })).toBeVisible();

	await run('tmux', ['kill-session', '-t', session.tmuxSession]);
	const endedGroup = page.locator('.session-group.ended');
	await expect(endedGroup.getByRole('button', { name: /Ended/ })).toHaveAttribute('aria-expanded', 'true', { timeout: 3_000 });
	await expect(endedGroup.locator('.session-row', { hasText: 'workspace' })).toBeVisible();
});

test('keeps an externally changed file when an editor save conflicts', async ({ context, page }) => {
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
	await expect(editor).toBeVisible();
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
