import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { authenticate, createSession, expectTerminalReady, removeSession } from './support.mjs';

let sessionId;
const run = promisify(execFile);

test.afterEach(async ({ context }) => {
	await removeSession(context, sessionId);
	sessionId = undefined;
});

test('keeps the core workspace flow usable in a narrow viewport', async ({ context, page }) => {
	await authenticate(context);
	const session = await createSession(context);
	sessionId = session.id;

	await page.goto(`/sessions/${encodeURIComponent(session.id)}`);
	await expectTerminalReady(page);
	await expect(page.getByRole('textbox', { name: 'Terminal input' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Scroll to terminal top' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Scroll to terminal bottom' })).toBeVisible();

	await run('tmux', ['send-keys', '-t', session.tmuxSession, '-l', '--', 'seq 1 200']);
	await run('tmux', ['send-keys', '-t', session.tmuxSession, 'Enter']);
	const terminalRows = page.locator('.xterm-rows');
	await expect.poll(() => terminalRows.innerText()).toContain('200');
	await page.getByRole('button', { name: 'Scroll to terminal top' }).click();
	await expect.poll(async () => !(await terminalRows.innerText()).includes('200')).toBe(true);
	await page.getByRole('button', { name: 'Scroll to terminal bottom' }).click();
	await expect.poll(() => terminalRows.innerText()).toContain('200');

	await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

	await page.getByRole('button', { name: 'Open workspaces' }).click();
	await expect(page.getByRole('heading', { name: 'Workspaces' })).toBeVisible();
	await page.getByRole('button', { name: /Open running workspace workspace/ }).click();
	await expectTerminalReady(page);

	await page.getByRole('button', { name: 'Open repository' }).click();
	await expect(page.getByRole('complementary', { name: 'Repository for workspace' })).toBeVisible();
	await expect(page.getByRole('tab', { name: 'Files' })).toBeVisible();
	await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	await page.getByRole('button', { name: 'Close repository' }).click();
	await expect(page.getByRole('textbox', { name: 'Terminal input' })).toBeVisible();
});
