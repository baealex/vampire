import { expect } from '@playwright/test';
import type { APIRequestContext, BrowserContext, Page } from '@playwright/test';
import type { ManagedWorkspace } from '../src/lib/shared/contracts/workspace.ts';
import { defaultStatusPlugins } from '../src/lib/shared/contracts/status-plugin.ts';
import { E2E_BASE_URL, E2E_TOKEN, E2E_WORKSPACE_DIRECTORY } from './runtime.ts';

export { E2E_WORKSPACE_DIRECTORY };

const authenticatedRequests = new WeakMap<APIRequestContext, Promise<void>>();

function authenticateRequest(request: APIRequestContext): Promise<void> {
  let authentication = authenticatedRequests.get(request);
  if (!authentication) {
    authentication = (async () => {
      const status = await request.get(`${E2E_BASE_URL}/api/status`);
      expect(status.ok()).toBe(true);
      const body = (await status.json()) as { authenticated?: boolean };
      if (body.authenticated) return;

      const response = await request.post(`${E2E_BASE_URL}/api/login`, { data: { token: E2E_TOKEN } });
      expect(response.ok()).toBe(true);
    })().finally(() => authenticatedRequests.delete(request));
    authenticatedRequests.set(request, authentication);
  }
  return authentication;
}

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
  await authenticateRequest(request);
  const response = await request.get(`${E2E_BASE_URL}/api/workspaces`);
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { workspaces: ManagedWorkspace[] };
  for (const workspace of body.workspaces) {
    const removal = await request.delete(
      `${E2E_BASE_URL}/api/workspaces/${encodeURIComponent(workspace.id)}?terminate=true`,
      {}
    );
    expect(removal.ok()).toBe(true);
  }
  const launchProfiles = await request.put(`${E2E_BASE_URL}/api/launch-profiles`, {
    data: { launchProfiles: [] },
  });
  expect(launchProfiles.ok()).toBe(true);
  const preferences = await request.put(`${E2E_BASE_URL}/api/workspace-preferences`, {
    data: { workspaceOrderMode: 'activity', manualWorkspaceOrder: [] },
  });
  expect(preferences.ok()).toBe(true);
}

export async function resetStatusPlugins(request: APIRequestContext): Promise<void> {
  await authenticateRequest(request);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await request.put(`${E2E_BASE_URL}/api/status-plugins`, {
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

export async function resetTerminalInputSettings(request: APIRequestContext): Promise<void> {
  await authenticateRequest(request);
  const response = await request.put(`${E2E_BASE_URL}/api/terminal-input/settings`, {
    data: { mode: 'terminal', slashHandoff: true },
  });
  expect(response.ok()).toBe(true);
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

export async function observeTerminalFrames(
  page: Page,
  stableMarker?: string
): Promise<() => Promise<{ blankFrames: number; invalidRowContainerFrames: number; unstableMarkerFrames: number }>> {
  await page.evaluate((marker) => {
    const target = window as typeof window & {
      __vampireTerminalFrameObservation?: {
        animationFrame: number;
        blankFrames: number;
        invalidRowContainerFrames: number;
        unstableMarkerFrames: number;
      };
    };
    const observation = {
      animationFrame: 0,
      blankFrames: 0,
      invalidRowContainerFrames: 0,
      unstableMarkerFrames: 0,
    };
    target.__vampireTerminalFrameObservation = observation;
    const sample = () => {
      const terminal = document.querySelector('[aria-label="Interactive shell terminal"]');
      const rows =
        terminal?.querySelector<HTMLElement>('.terminal-render-shield') ??
        terminal?.querySelector<HTMLElement>('.xterm-screen > .xterm-rows');
      if (rows && !Array.from(rows.children).some((row) => Boolean(row.textContent))) observation.blankFrames += 1;
      if (rows && marker && rows.textContent?.split(marker).length !== 2) observation.unstableMarkerFrames += 1;
      if (terminal && terminal.querySelectorAll('.xterm-screen > .xterm-rows').length !== 1) {
        observation.invalidRowContainerFrames += 1;
      }
      observation.animationFrame = requestAnimationFrame(sample);
    };
    observation.animationFrame = requestAnimationFrame(sample);
  }, stableMarker);
  return () =>
    page.evaluate(() => {
      const target = window as typeof window & {
        __vampireTerminalFrameObservation?: {
          animationFrame: number;
          blankFrames: number;
          invalidRowContainerFrames: number;
          unstableMarkerFrames: number;
        };
      };
      const observation = target.__vampireTerminalFrameObservation;
      if (!observation) return { blankFrames: -1, invalidRowContainerFrames: -1, unstableMarkerFrames: -1 };
      cancelAnimationFrame(observation.animationFrame);
      delete target.__vampireTerminalFrameObservation;
      return {
        blankFrames: observation.blankFrames,
        invalidRowContainerFrames: observation.invalidRowContainerFrames,
        unstableMarkerFrames: observation.unstableMarkerFrames,
      };
    });
}
