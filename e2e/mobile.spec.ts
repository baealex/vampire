import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { authenticate, createSession, expectTerminalReady, removeSession, resetSessions } from './support.ts';

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

test('keeps the core workspace flow usable in a narrow viewport', async ({ context, page }) => {
	test.setTimeout(60_000);
	await authenticate(context);
	const session = await createSession(context);
	sessionId = session.id;

	await page.goto(`/sessions/${encodeURIComponent(session.id)}`);
	await expectTerminalReady(page);
	const terminalTypography = await page.getByRole('application', { name: 'Interactive shell terminal' }).evaluate((terminal) => {
		const rows = terminal.querySelector<HTMLElement>('.xterm-rows');
		return {
			language: terminal.getAttribute('lang'),
			fontFamily: rows ? getComputedStyle(rows).fontFamily : ''
		};
	});
	expect(terminalTypography.language).toBe(await page.evaluate(() => navigator.language || 'und'));
	expect(terminalTypography.fontFamily).toContain('system-ui');
	expect(terminalTypography.fontFamily).toContain('sans-serif');
	expect(terminalTypography.fontFamily).not.toMatch(/(?:^|,)\s*(?:ui-)?monospace\s*(?:,|$)/);
	await run('tmux', ['send-keys', '-t', session.tmuxSession, '-l', '--', "printf '한글 日本語 简体中文 Русский Ελληνικά العربية עברית हिन्दी ไทย 😀\\n'"]);
	await run('tmux', ['send-keys', '-t', session.tmuxSession, 'Enter']);
	await expect(page.locator('.xterm-rows')).toContainText('한글 日本語 简体中文 Русский Ελληνικά العربية עברית हिन्दी ไทย 😀');
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

	const runBackground = page.getByRole('button', { name: 'Run background command' });
	await expect(runBackground).toBeVisible();
	await expect.poll(() => page.evaluate(() => {
		const bar = document.querySelector<HTMLElement>('.background-bar');
		const toggle = document.querySelector<HTMLElement>('.background-toggle');
		if (!bar || !toggle) return false;
		const barBox = bar.getBoundingClientRect();
		const toggleBox = toggle.getBoundingClientRect();
		return Math.abs(barBox.left - toggleBox.left) < 1 && Math.abs(barBox.right - toggleBox.right) < 1;
	})).toBe(true);
	await runBackground.click();
	await page.getByRole('textbox', { name: 'Background command' }).fill('sleep 30');
	await page.getByRole('button', { name: 'Run', exact: true }).click();
	const stopBackground = page.getByRole('button', { name: 'Stop sleep 30' });
	await expect(stopBackground).toBeVisible();
	await expect.poll(() => stopBackground.evaluate((button) => button.getBoundingClientRect().right <= window.innerWidth)).toBe(true);
	await stopBackground.click();
	await expect(stopBackground).toBeHidden();

	await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

	await page.getByRole('button', { name: 'Open workspaces' }).click();
	await expect(page.getByRole('heading', { name: 'Workspaces' })).toBeVisible();
	await page.getByRole('button', { name: /Open running workspace workspace/ }).click();
	await expectTerminalReady(page);

	await page.getByRole('button', { name: 'Open repository' }).click();
	await expect(page.getByRole('complementary', { name: 'Repository for workspace' })).toBeVisible();
	await expect(page.getByRole('tab', { name: 'Files' })).toBeVisible();
	await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	await page.getByRole('tab', { name: 'Files' }).click();
	await page.getByRole('button', { name: 'Open conflict.txt' }).click();
	await expect(page.locator('[aria-label="Edit conflict.txt"] .cm-content')).toBeVisible({ timeout: 15_000 });
	await page.getByRole('button', { name: 'Close file and return to terminal' }).click();
	await expect(page.getByRole('textbox', { name: 'Terminal input' })).toBeVisible();
});
