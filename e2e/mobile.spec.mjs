import { expect, test } from '@playwright/test';
import { authenticate, createSession, expectTerminalReady, removeSession } from './support.mjs';

let sessionId;

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
