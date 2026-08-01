import { expect } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import type { ManagedSession } from '../src/lib/session/types.ts';
import {
	E2E_BASE_URL,
	E2E_TOKEN,
	E2E_WORKSPACE_DIRECTORY
} from './runtime.ts';

export { E2E_WORKSPACE_DIRECTORY };

export async function authenticate(context: BrowserContext): Promise<void> {
	const response = await context.request.post(`${E2E_BASE_URL}/api/login`, {
		data: { token: E2E_TOKEN }
	});
	expect(response.ok()).toBe(true);
}

export async function createSession(context: BrowserContext): Promise<ManagedSession> {
	const response = await context.request.post(`${E2E_BASE_URL}/api/sessions`, {
		data: { cwd: E2E_WORKSPACE_DIRECTORY }
	});
	expect(response.status()).toBe(201);
	const body = await response.json() as { session: ManagedSession };
	return body.session;
}

export async function removeSession(context: BrowserContext, sessionId: string | undefined): Promise<void> {
	if (!sessionId) return;
	await context.request.delete(`${E2E_BASE_URL}/api/sessions/${encodeURIComponent(sessionId)}?terminate=true`);
}

export async function expectTerminalReady(page: Page): Promise<void> {
	await expect(page.getByRole('application', { name: 'Interactive shell terminal' })).toBeVisible();
	await expect(page.locator('.terminal.screen-ready')).toBeVisible({ timeout: 15_000 });
}
