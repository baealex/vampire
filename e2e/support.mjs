import { expect } from '@playwright/test';
import {
	E2E_BASE_URL,
	E2E_TOKEN,
	E2E_WORKSPACE_DIRECTORY
} from '../scripts/e2e-runtime.mjs';

export { E2E_WORKSPACE_DIRECTORY };

export async function authenticate(context) {
	const response = await context.request.post(`${E2E_BASE_URL}/api/login`, {
		data: { token: E2E_TOKEN }
	});
	expect(response.ok()).toBe(true);
}

export async function createSession(context) {
	const response = await context.request.post(`${E2E_BASE_URL}/api/sessions`, {
		data: { cwd: E2E_WORKSPACE_DIRECTORY }
	});
	expect(response.status()).toBe(201);
	const body = await response.json();
	return body.session;
}

export async function removeSession(context, sessionId) {
	if (!sessionId) return;
	await context.request.delete(`${E2E_BASE_URL}/api/sessions/${encodeURIComponent(sessionId)}?terminate=true`);
}

export async function expectTerminalReady(page) {
	await expect(page.getByRole('application', { name: 'Interactive shell terminal' })).toBeVisible();
	await expect(page.locator('.terminal.screen-ready')).toBeVisible({ timeout: 15_000 });
}
