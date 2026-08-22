import { expect } from '@playwright/test';
import type { APIRequestContext, BrowserContext, Page } from '@playwright/test';
import type { ManagedWorkspace } from '../src/lib/shared/contracts/workspace.ts';
import { defaultStatusPlugins } from '../src/lib/shared/contracts/status-plugin.ts';
import { E2E_BASE_URL, E2E_TOKEN, E2E_WORKSPACE_DIRECTORY } from './runtime.ts';

export { E2E_WORKSPACE_DIRECTORY };

export async function authenticate(context: BrowserContext): Promise<void> {
  const response = await context.request.post(`${E2E_BASE_URL}/api/login`, {
    data: { token: E2E_TOKEN },
  });
  expect(response.ok()).toBe(true);
}

export async function createWorkspace(context: BrowserContext): Promise<ManagedWorkspace> {
  const response = await context.request.post(`${E2E_BASE_URL}/api/workspaces`, {
    data: { cwd: E2E_WORKSPACE_DIRECTORY },
  });
  expect(response.status()).toBe(201);
  const body = (await response.json()) as { workspace: ManagedWorkspace };
  return body.workspace;
}

export async function resetWorkspaces(request: APIRequestContext): Promise<void> {
  const headers = { authorization: `Bearer ${E2E_TOKEN}` };
  const response = await request.get(`${E2E_BASE_URL}/api/workspaces`, { headers });
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { workspaces: ManagedWorkspace[] };
  for (const workspace of body.workspaces) {
    const removal = await request.delete(
      `${E2E_BASE_URL}/api/workspaces/${encodeURIComponent(workspace.id)}?terminate=true`,
      { headers }
    );
    expect(removal.ok()).toBe(true);
  }
  const launchProfiles = await request.put(`${E2E_BASE_URL}/api/launch-profiles`, {
    headers,
    data: { launchProfiles: [] },
  });
  expect(launchProfiles.ok()).toBe(true);
  const preferences = await request.put(`${E2E_BASE_URL}/api/workspace-preferences`, {
    headers,
    data: { workspaceOrderMode: 'activity', manualWorkspaceOrder: [] },
  });
  expect(preferences.ok()).toBe(true);
}

export async function resetStatusPlugins(request: APIRequestContext): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await request.put(`${E2E_BASE_URL}/api/status-plugins`, {
        headers: { authorization: `Bearer ${E2E_TOKEN}` },
        data: { plugins: defaultStatusPlugins() },
      });
      expect(response.ok()).toBe(true);
      return;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const transientConnection = /\b(?:ECONNRESET|ECONNREFUSED|EPIPE)\b/.test(message);
      if (!transientConnection || attempt === 2) throw cause;
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
    }
  }
}

export async function removeWorkspace(context: BrowserContext, workspaceId: string | undefined): Promise<void> {
  if (!workspaceId) return;
  await context.request
    .delete(`${E2E_BASE_URL}/api/workspaces/${encodeURIComponent(workspaceId)}?terminate=true`)
    .catch(() => undefined);
}

export async function expectTerminalReady(page: Page): Promise<void> {
  await expect(page.getByRole('application', { name: 'Interactive shell terminal' })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.terminal.screen-ready')).toBeVisible({ timeout: 20_000 });
}
