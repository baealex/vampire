import { execFile } from 'node:child_process';
import { readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test, type Locator, type Page, type WebSocketRoute } from '@playwright/test';
import {
  authenticate,
  createWorkspace,
  E2E_WORKSPACE_DIRECTORY,
  expectTerminalReady,
  removeWorkspace,
  resetWorkspaces,
  resetStatusPlugins,
} from './support.ts';
import { E2E_STATE_DIRECTORY } from './runtime.ts';
import type { ManagedWorkspace } from '../src/lib/shared/contracts/workspace.ts';

declare global {
  interface Window {
    __vampireObservedWorkspaceStates: string[];
    __vampireWorkspaceStateTimer: number;
  }
}

let workspaceId: string | undefined;
const run = promisify(execFile);

async function gitWorkspace(...args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', E2E_WORKSPACE_DIRECTORY, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Vampire E2E',
      GIT_AUTHOR_EMAIL: 'vampire-e2e@example.test',
      GIT_COMMITTER_NAME: 'Vampire E2E',
      GIT_COMMITTER_EMAIL: 'vampire-e2e@example.test',
    },
  });
  return stdout;
}

async function tmuxPaneGeometry(tmuxSession: string): Promise<{ columns: number; rows: number }> {
  const { stdout } = await run('tmux', ['display-message', '-p', '-t', tmuxSession, '#{pane_width}\t#{pane_height}']);
  const [columns, rows] = stdout.trim().split('\t').map(Number);
  return { columns, rows };
}

async function tmuxPaneCursor(tmuxSession: string): Promise<{ column: number; row: number }> {
  const { stdout } = await run('tmux', ['display-message', '-p', '-t', tmuxSession, '#{cursor_x}\t#{cursor_y}']);
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
      screenWidth: screen?.getBoundingClientRect().width ?? 0,
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
  await expect
    .poll(async () => {
      const [expected, ...rendered] = await Promise.all([
        tmuxPaneRows(tmuxSession),
        ...pages.map(renderedTerminalRows),
      ]);
      return rendered
        .map((rows, index) => terminalRowsMismatch(expected, rows, index + 1))
        .filter(Boolean)
        .join('\n');
    })
    .toBe('');
  const expected = await tmuxPaneRows(tmuxSession);
  for (const page of pages) expect(await renderedTerminalRows(page)).toEqual(expected);
}

async function activateTerminal(page: Page): Promise<void> {
  await page.getByRole('application', { name: 'Interactive shell terminal' }).evaluate((terminal) => {
    terminal.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        pointerType: 'mouse',
        isPrimary: true,
      })
    );
  });
}

async function fillTerminalWithNumberedRows(tmuxSession: string, count = 300): Promise<void> {
  const command = `clear; i=1; while [ $i -le ${count} ]; do printf 'VAMP_ROW_%03d\\n' "$i"; i=$((i + 1)); done`;
  await run('tmux', ['send-keys', '-t', tmuxSession, '-l', '--', command]);
  await run('tmux', ['send-keys', '-t', tmuxSession, 'Enter']);
  const finalRow = `VAMP_ROW_${String(count).padStart(3, '0')}`;
  await expect.poll(async () => (await tmuxPaneRows(tmuxSession)).some((row) => row === finalRow)).toBe(true);
}

interface ObservedTerminalMessage {
  direction: 'client' | 'server';
  historyAvailable?: number;
  historyLoaded?: number;
  lines?: number;
  snapshotData?: string;
  slot?: number;
  type?: string;
}

async function observeTerminalMessages(page: Page, messages: ObservedTerminalMessage[]): Promise<void> {
  await page.routeWebSocket(/\/ws\/terminal(?:\?|$)/, (socket) => {
    const server = socket.connectToServer();
    const record = (direction: ObservedTerminalMessage['direction'], message: string | Buffer) => {
      try {
        const value = JSON.parse(typeof message === 'string' ? message : message.toString()) as {
          history?: { available?: unknown; loaded?: unknown };
          data?: unknown;
          lines?: unknown;
          slot?: unknown;
          type?: unknown;
        };
        messages.push({
          direction,
          ...(typeof value.history?.available === 'number' ? { historyAvailable: value.history.available } : {}),
          ...(typeof value.history?.loaded === 'number' ? { historyLoaded: value.history.loaded } : {}),
          ...(typeof value.lines === 'number' ? { lines: value.lines } : {}),
          ...(value.type === 'snapshot' && typeof value.data === 'string' ? { snapshotData: value.data } : {}),
          ...(typeof value.type === 'string' ? { type: value.type } : {}),
          ...(typeof value.slot === 'number' ? { slot: value.slot } : {}),
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

async function dropWorkspaceEntry(target: Locator, entry: { path: string; kind: 'file' | 'directory' }): Promise<void> {
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
  const reports = messages
    .slice(requestIndex + 1)
    .filter((message) => message.direction === 'client' && message.type === 'terminal-color');
  return reports.some((message) => message.slot === 10) && reports.some((message) => message.slot === 11);
}

test.beforeEach(async ({ request }) => {
  workspaceId = undefined;
  await Promise.all([resetWorkspaces(request), resetStatusPlugins(request)]);
});

test.afterEach(async ({ context }) => {
  await removeWorkspace(context, workspaceId);
  workspaceId = undefined;
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
  await expect(page.getByRole('region', { name: 'Workspace list' })).toBeVisible();
});

test('inspects listening ports as an on-demand system utility', async ({ context, page }) => {
  await authenticate(context);
  const workspace = await createWorkspace(context);
  workspaceId = workspace.id;
  let portsRequests = 0;
  let releaseRevalidation: (() => void) | undefined;
  const revalidationGate = new Promise<void>((resolve) => {
    releaseRevalidation = resolve;
  });
  await page.route('**/api/system/ports', async (route) => {
    portsRequests += 1;
    if (portsRequests === 2) await revalidationGate;
    await route.fulfill({
      json: {
        ports:
          portsRequests === 1
            ? [
                {
                  protocol: 'tcp',
                  port: 5173,
                  addresses: ['127.0.0.1', '::1'],
                  pid: 321,
                  processName: 'node',
                  cwd: '/projects/site',
                  termination: 'available',
                },
                {
                  protocol: 'tcp',
                  port: 7678,
                  addresses: ['127.0.0.1'],
                  pid: 999,
                  processName: 'node',
                  cwd: '/projects/vampire',
                  termination: 'protected',
                },
              ]
            : [
                {
                  protocol: 'tcp',
                  port: 5173,
                  addresses: ['127.0.0.1', '::1'],
                  pid: 321,
                  processName: 'node',
                  cwd: '/projects/site',
                  termination: 'available',
                },
                {
                  protocol: 'tcp',
                  port: 7678,
                  addresses: ['127.0.0.1'],
                  pid: 999,
                  processName: 'node',
                  cwd: '/projects/vampire',
                  termination: 'protected',
                },
                {
                  protocol: 'tcp',
                  port: 4173,
                  addresses: ['127.0.0.1'],
                  pid: 654,
                  processName: 'vite',
                  cwd: '/projects/site',
                  termination: 'available',
                },
              ],
      },
    });
  });

  await page.goto(`/workspaces/${encodeURIComponent(workspace.id)}`);
  await expectTerminalReady(page);
  const statusBar = page.getByRole('region', { name: 'Server status plugins' });
  await expect(statusBar).toBeVisible();
  await expect(statusBar.locator('.status-plugin').filter({ hasText: 'CPU' })).toContainText('≈');
  await expect(statusBar.locator('.status-plugin').filter({ hasText: 'RAM' })).toContainText('%');
  await expect(page.getByRole('button', { name: 'Inspect listening ports' })).toBeVisible();
  await page.getByRole('button', { name: 'Inspect listening ports' }).click();
  const portsDialog = page.getByRole('dialog', { name: 'Listening ports' });
  await expect(portsDialog.getByRole('heading', { name: 'Listening ports' })).toBeVisible();
  await expect(portsDialog.getByRole('searchbox', { name: 'Filter listening ports' })).toBeFocused();
  await expect(page.getByText('2 ports')).toBeVisible();
  const developmentServer = page.locator('.listening-port-row', { hasText: '5173' });
  await expect(developmentServer).toContainText('Localhost');
  await expect(developmentServer).toContainText('/projects/site');
  const toolbarBox = await portsDialog.locator('.listening-ports-toolbar').boundingBox();
  const resultsBox = await portsDialog.locator('.listening-port-results').boundingBox();
  expect(toolbarBox).not.toBeNull();
  expect(resultsBox).not.toBeNull();
  expect(resultsBox!.y - (toolbarBox!.y + toolbarBox!.height)).toBeLessThan(32);
  await expect(portsDialog.locator('.vampire-dialog-body')).toHaveCSS('overflow-y', 'auto');
  await expect(portsDialog.locator('.listening-port-list')).toHaveCSS('overflow-y', 'visible');
  expect(portsRequests).toBe(1);
  await portsDialog.getByRole('button', { name: 'Close' }).click();
  await expect(portsDialog.getByRole('heading', { name: 'Listening ports' })).toBeHidden();
  await page.getByRole('button', { name: 'Inspect listening ports' }).click();
  await expect(page.getByText('2 ports')).toBeVisible();
  await expect.poll(() => portsRequests).toBe(2);
  releaseRevalidation!();
  await expect(page.getByText('3 ports')).toBeVisible();
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

test('stores agent automations and exposes the exact live note path only on request', async ({ context, page }) => {
  await authenticate(context);
  const workspace = await createWorkspace(context);
  workspaceId = workspace.id;
  await page.goto(`/workspaces/${encodeURIComponent(workspace.id)}`);
  await expectTerminalReady(page);

  await page.getByRole('button', { name: /Workspace actions for/ }).click();
  await page.getByRole('menuitem', { name: 'Agent automations' }).click();
  const automationDialog = page.getByRole('dialog', { name: 'Agent automations' });
  await expect(automationDialog).toBeVisible();
  await expect(automationDialog.getByLabel('Name')).toBeFocused();
  await automationDialog.getByLabel('Name').fill('Review project state');
  await automationDialog.getByLabel('Prompt').fill('Review the current work and identify the next useful step.');
  await automationDialog.getByRole('button', { name: 'Add automation' }).click();
  const savedAutomation = automationDialog.locator('article', { hasText: 'Review project state' });
  await expect(savedAutomation).toBeVisible();
  await expect(savedAutomation).toContainText('One time');
  await savedAutomation.getByRole('button', { name: 'Delete' }).click();
  await expect(savedAutomation).toBeHidden();
  await automationDialog.getByRole('button', { name: 'Close agent automations' }).click();

  await page.getByRole('button', { name: 'Add workspace note' }).click();
  await expect(page.getByRole('button', { name: 'Add workspace note' })).toHaveCount(0);
  const noteDialog = page.getByRole('dialog', { name: 'Workspace note' });
  const noteInput = noteDialog.getByRole('textbox', { name: 'Workspace note' });
  await noteInput.fill('Existing project context');
  await expect(noteDialog.getByText('Saved', { exact: true })).toBeVisible();
  await noteDialog.getByRole('button', { name: 'Summarize with agent' }).click();
  await expect(noteDialog.getByRole('button', { name: 'Waiting for note update' })).toBeVisible();

  const notePath = join(E2E_STATE_DIRECTORY, `${workspace.id}.note.md`);
  await expect(noteDialog.locator('.note-agent-target')).toContainText(notePath);
  await expect.poll(async () => readFile(notePath, 'utf8')).toBe('Existing project context\n');
  const automationsResponse = await context.request.get(
    `/api/workspaces/${encodeURIComponent(workspace.id)}/automations`
  );
  expect(automationsResponse.ok()).toBe(true);
  const automationsBody = (await automationsResponse.json()) as {
    automations: Array<{ kind: string; prompt: string }>;
  };
  expect(automationsBody.automations).toHaveLength(1);
  expect(automationsBody.automations[0]?.kind).toBe('note');
  expect(automationsBody.automations[0]?.prompt).toContain(notePath);
  expect(automationsBody.automations[0]?.prompt).toContain(
    "Infer the document language from the user's language and the conversation context."
  );
});

test('manages server-wide status plugins and shares their ordered output across tabs', async ({ context, page }) => {
  await authenticate(context);
  const workspace = await createWorkspace(context);
  workspaceId = workspace.id;
  await page.goto(`/workspaces/${encodeURIComponent(workspace.id)}`);
  await expectTerminalReady(page);

  await page.getByRole('button', { name: 'Manage status widgets' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Add widget' }).click();
  await page.getByRole('menuitem', { name: 'Codex Limit', exact: true }).click();
  const codexLimit = dialog.locator('.status-detail-editor');
  await expect(codexLimit.getByLabel('Command')).toHaveValue(/account\/rateLimits\/read/);
  await expect(codexLimit.getByLabel('Command')).toHaveValue(/\n/);
  await expect(codexLimit.getByLabel('Enabled')).toBeChecked();
  await codexLimit.getByRole('button', { name: 'Remove Codex Limit' }).click();
  await dialog.getByRole('button', { name: 'Add widget' }).click();
  await page.getByRole('menuitem', { name: 'Command', exact: true }).click();
  const custom = dialog.locator('.status-detail-editor');
  await custom.getByLabel('Name').fill('Build');
  await custom.getByLabel('Command').fill("printf 'ready\\nShared result\\n'");
  await custom.getByRole('spinbutton', { name: 'Every' }).fill('60');
  await dialog.getByRole('button', { name: 'Back to status widgets' }).click();
  await dialog.getByRole('button', { name: 'Actions for Build' }).click();
  await page.getByRole('menuitem', { name: 'Move Build up' }).click();
  await dialog.getByRole('button', { name: 'Actions for Build' }).click();
  await page.getByRole('menuitem', { name: 'Move Build up' }).click();

  await dialog.getByRole('button', { name: 'Edit CPU' }).click();
  const cpu = dialog.locator('.status-detail-editor');
  await expect(cpu.getByLabel('Command')).toHaveValue(/^node --input-type=module/);
  await expect(cpu.getByLabel('Command')).toHaveValue(/function snapshot\(\)/);
  await dialog.getByRole('button', { name: 'Back to status widgets' }).click();
  await dialog.getByRole('button', { name: 'Actions for CPU' }).click();
  await page.getByRole('menuitem', { name: 'Remove CPU' }).click();
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(dialog).toBeHidden();

  const firstBar = page.getByRole('region', { name: 'Server status plugins' });
  await expect(firstBar.locator('.status-plugin').first()).toContainText('Build');
  await expect(firstBar.locator('.status-plugin').first()).toContainText('ready');
  await expect(firstBar.locator('.status-plugin').filter({ hasText: 'CPU' })).toHaveCount(0);
  await firstBar.locator('.status-plugin').first().click();
  await expect(page.locator('.status-plugin-popover')).toBeVisible();
  const terminalScreen = page.locator('.xterm-screen');
  const terminalBounds = await terminalScreen.boundingBox();
  expect(terminalBounds).not.toBeNull();
  await terminalScreen.click({
    position: { x: terminalBounds!.width - 40, y: terminalBounds!.height / 2 },
  });
  await expect(page.locator('.status-plugin-popover')).toBeHidden();
  await expect(page.locator('.xterm-helper-textarea')).toBeFocused();

  const secondPage = await context.newPage();
  await secondPage.goto(`/workspaces/${encodeURIComponent(workspace.id)}`);
  await expectTerminalReady(secondPage);
  const secondBar = secondPage.getByRole('region', { name: 'Server status plugins' });
  await expect(secondBar.locator('.status-plugin').first()).toContainText('Build');
  await expect(secondBar.locator('.status-plugin').first()).toContainText('ready');
  await expect(secondBar.locator('.status-plugin').nth(1)).toContainText('RAM');
  await secondPage.close();
});

test('adds a startup profile inline, reuses it elsewhere, and runs the workspace selection', async ({
  context,
  page,
}) => {
  await authenticate(context);
  const workspace = await createWorkspace(context);
  workspaceId = workspace.id;
  const profileCommand = "printf 'launch-profile-marker\\n'";

  await page.goto(`/workspaces/${encodeURIComponent(workspace.id)}`);
  await expectTerminalReady(page);
  let actions = page.locator('.workspace-row-shell.selected .workspace-actions-menu .vampire-menu-trigger');
  await actions.click();
  await page.getByRole('menuitem', { name: 'Startup profile' }).click();
  await expect(page.getByRole('menu')).toBeHidden();
  await page.getByRole('button', { name: 'Add profile' }).click();
  const profileCard = page.locator('.profile-card').last();
  await profileCard.getByLabel('Name').fill('Codex');
  await profileCard.getByLabel('Command').fill(profileCommand);
  await expect(profileCard.getByRole('radio', { name: 'Use here' })).toBeChecked();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('heading', { name: 'Startup profile' })).toBeHidden();

  const profilesResponse = await context.request.get('/api/launch-profiles');
  expect(profilesResponse.ok()).toBe(true);
  const profilesBody = (await profilesResponse.json()) as {
    launchProfiles: Array<{ id: string; name: string; command: string }>;
  };
  expect(profilesBody.launchProfiles).toHaveLength(1);
  expect(profilesBody.launchProfiles[0]).toMatchObject({ name: 'Codex', command: profileCommand });

  const reuseWorkspace = await createWorkspace(context);
  await page.goto(`/workspaces/${encodeURIComponent(reuseWorkspace.id)}`);
  await expectTerminalReady(page);
  actions = page.locator('.workspace-row-shell.selected .workspace-actions-menu .vampire-menu-trigger');
  await actions.click();
  await page.getByRole('menuitem', { name: 'Startup profile' }).click();
  await expect(page.locator('input.command-input')).toHaveValue(profileCommand);
  await expect(page.getByRole('radio', { name: /No startup profile/ })).toBeChecked();
  await page.locator('.profile-card').getByRole('radio', { name: 'Use here' }).click();
  await page.getByRole('button', { name: 'Save changes' }).click();
  const reuseWorkspacesResponse = await context.request.get('/api/workspaces');
  const reuseWorkspacesBody = (await reuseWorkspacesResponse.json()) as { workspaces: ManagedWorkspace[] };
  expect(reuseWorkspacesBody.workspaces.find((candidate) => candidate.id === reuseWorkspace.id)?.startupProfileId).toBe(
    profilesBody.launchProfiles[0]!.id
  );
  await removeWorkspace(context, reuseWorkspace.id);

  const closeResponse = await context.request.post(`/api/workspaces/${encodeURIComponent(workspace.id)}/close`);
  expect(closeResponse.ok()).toBe(true);

  await page.goto('/');
  const endedGroup = page.locator('.workspace-group.ended');
  await endedGroup.getByRole('button', { name: /Ended/ }).click();
  const endedActions = endedGroup.locator('.workspace-actions-menu .vampire-menu-trigger');
  await expect(endedActions).toBeVisible();
  await endedActions.click();
  await page.getByRole('menuitem', { name: 'Startup profile' }).click();
  await expect(page.getByRole('heading', { name: 'Startup profile' })).toBeVisible();
  await expect(page.locator('.profile-card').getByRole('radio', { name: 'Use here' })).toBeChecked();
  const startupDialog = page.getByRole('dialog', { name: 'Startup profile' });
  await expect(startupDialog.locator('.vampire-dialog-body')).toHaveCSS('overflow-y', 'auto');
  await expect(startupDialog.locator('.vampire-dialog-footer')).toHaveCount(0);
  await page.getByRole('button', { name: 'Close', exact: true }).click();

  const restartResponse = await context.request.post(`/api/workspaces/${encodeURIComponent(workspace.id)}`);
  expect(restartResponse.ok()).toBe(true);

  await page.goto(`/workspaces/${encodeURIComponent(workspace.id)}`);
  await expectTerminalReady(page);
  await expect(page.locator('.xterm-rows')).toContainText('launch-profile-marker');
  actions = page.locator('.workspace-row-shell.selected .workspace-actions-menu .vampire-menu-trigger');
  await expect(actions).toBeVisible();
  await actions.click();
  await page.getByRole('menuitem', { name: 'Startup profile' }).click();
  await expect(page.locator('.profile-card').getByRole('radio', { name: 'Use here' })).toBeChecked();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
});

test('reopens with a one-time profile without changing the default startup', async ({ context, page }) => {
  await authenticate(context);
  const workspace = await createWorkspace(context);
  workspaceId = workspace.id;
  const profileCommand = "printf 'one-time-profile-marker\\n'";

  const profilesResponse = await context.request.put('/api/launch-profiles', {
    data: {
      launchProfiles: [
        {
          id: 'profile-one-time',
          name: 'Codex',
          command: profileCommand,
        },
      ],
    },
  });
  expect(profilesResponse.ok()).toBe(true);

  const closeResponse = await context.request.post(`/api/workspaces/${encodeURIComponent(workspace.id)}/close`);
  expect(closeResponse.ok()).toBe(true);

  await page.goto('/');
  const endedGroup = page.locator('.workspace-group.ended');
  await endedGroup.getByRole('button', { name: /Ended/ }).click();
  await endedGroup.locator('.workspace-row').click();
  await expect(page.getByRole('heading', { name: 'This shell has ended' })).toBeVisible();
  await page.getByRole('button', { name: 'Reopen with…' }).click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: 'Blank terminal' })).toBeVisible();
  await menu.getByRole('menuitem', { name: /Codex/ }).click();

  await expectTerminalReady(page);
  await expect(page.locator('.xterm-rows')).toContainText('one-time-profile-marker');

  const restartedWorkspacesResponse = await context.request.get('/api/workspaces');
  expect(restartedWorkspacesResponse.ok()).toBe(true);
  const restartedWorkspacesBody = (await restartedWorkspacesResponse.json()) as { workspaces: ManagedWorkspace[] };
  expect(
    restartedWorkspacesBody.workspaces.find((candidate) => candidate.id === workspace.id)?.startupProfileId
  ).toBeNull();

  const secondCloseResponse = await context.request.post(`/api/workspaces/${encodeURIComponent(workspace.id)}/close`);
  expect(secondCloseResponse.ok()).toBe(true);

  await page.goto(`/workspaces/${encodeURIComponent(workspace.id)}`);
  await expect(page.getByRole('heading', { name: 'This shell has ended' })).toBeVisible();
  await page.getByRole('button', { name: 'Reopen shell' }).click();
  await expectTerminalReady(page);
  await expect
    .poll(async () => (await tmuxPaneRows(workspace.tmuxSession)).join('\n'))
    .not.toContain('one-time-profile-marker');
});

test('closes the workspace action menu after closing a workspace', async ({ context, page }) => {
  await authenticate(context);
  const workspace = await createWorkspace(context);
  workspaceId = workspace.id;

  await page.goto(`/workspaces/${encodeURIComponent(workspace.id)}`);
  await expectTerminalReady(page);
  await page.locator('.workspace-row-shell.selected .workspace-actions-menu .vampire-menu-trigger').click();
  const menu = page.getByRole('menu');
  await menu.getByRole('menuitem', { name: 'Close workspace' }).click();
  const confirmation = menu.getByRole('group', { name: 'Confirm closing workspace' });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('menuitem', { name: 'Close workspace' }).click();

  await expect(menu).toBeHidden();
  await expect(page.locator('.workspace-group.ended')).toContainText('Ended');
});

test('creates, auto-starts, and safely removes an isolated Git workspace', async ({ context, page }) => {
  test.setTimeout(45_000);
  const gitDirectory = join(E2E_WORKSPACE_DIRECTORY, '.git');
  const trackedFile = join(E2E_WORKSPACE_DIRECTORY, 'conflict.txt');
  let isolatedBranch: string | undefined;
  await rm(gitDirectory, { recursive: true, force: true });
  await writeFile(trackedFile, 'committed workspace content\n', 'utf8');
  await gitWorkspace('init', '--quiet');
  await gitWorkspace('add', 'conflict.txt');
  await gitWorkspace('commit', '--quiet', '-m', 'initial');
  await writeFile(trackedFile, 'uncommitted source content\n', 'utf8');

  try {
    await authenticate(context);
    const source = await createWorkspace(context);
    workspaceId = source.id;
    const profileResponse = await context.request.put('/api/launch-profiles', {
      data: {
        launchProfiles: [
          {
            id: 'profile-isolated',
            name: 'Isolated marker',
            command: "printf 'auto-started\\n' > .vampire-auto-profile-marker",
          },
        ],
      },
    });
    expect(profileResponse.ok()).toBe(true);
    const selectionResponse = await context.request.put(
      `/api/workspaces/${encodeURIComponent(source.id)}/startup-profile`,
      {
        data: { startupProfileId: 'profile-isolated' },
      }
    );
    expect(selectionResponse.ok()).toBe(true);
    await page.goto(`/workspaces/${encodeURIComponent(source.id)}`);
    await expectTerminalReady(page);

    const actions = page.locator('.workspace-row-shell.selected .workspace-actions-menu .vampire-menu-trigger');
    await actions.click();
    await page.getByRole('menuitem', { name: 'New isolated workspace' }).click();
    await expect(page.getByRole('heading', { name: 'New isolated workspace' })).toBeVisible();
    const taskName = page.getByLabel('Task name');
    await expect(taskName).toBeFocused();
    expect(await taskName.getAttribute('placeholder')).toBeNull();
    await taskName.fill('Parallel task');
    await page.getByRole('button', { name: 'Create workspace' }).click();
    await expect(page.locator('.terminal-identity-title strong')).toHaveText('Parallel task');
    await expectTerminalReady(page);

    const workspacesResponse = await context.request.get('/api/workspaces');
    expect(workspacesResponse.ok()).toBe(true);
    const workspacesBody = (await workspacesResponse.json()) as { workspaces: ManagedWorkspace[] };
    const isolated = workspacesBody.workspaces.find((workspace) => workspace.workspaceLabel === 'Parallel task');
    expect(isolated).toBeDefined();
    expect(isolated?.workspaceKind).toBe('worktree');
    expect(isolated?.cwd).toBe(join(E2E_STATE_DIRECTORY, 'worktrees', isolated!.id, basename(E2E_WORKSPACE_DIRECTORY)));
    expect(isolated?.worktreeBranch).toMatch(/^vampire\/parallel-task-[a-f0-9]{8}$/);
    isolatedBranch = isolated!.worktreeBranch;
    expect(isolated?.startupProfileId).toBe('profile-isolated');
    expect(await readFile(join(isolated!.cwd, 'conflict.txt'), 'utf8')).toBe('committed workspace content\n');
    await expect
      .poll(() => readFile(join(isolated!.cwd, '.vampire-auto-profile-marker'), 'utf8').catch(() => ''))
      .toBe('auto-started\n');
    await page.reload();
    await expect(page.locator('.terminal-identity-title strong')).toHaveText('Parallel task');
    await expect(page.locator('.terminal-identity-title .worktree-badge')).toHaveText('Worktree');
    await expect(page.locator('.workspace-row-shell.selected .workspace-origin')).toContainText(
      isolated!.worktreeBranch!
    );
    await expectTerminalReady(page);

    await rm(isolated!.cwd, { recursive: true, force: true });
    await expect(page.locator('.working-copy-missing')).toBeVisible({ timeout: 12_000 });
    await expect(page.getByRole('application', { name: 'Interactive shell terminal' })).toBeVisible();
    expect((await gitWorkspace('branch', '--list', isolated!.worktreeBranch!)).trim()).toContain(
      isolated!.worktreeBranch!
    );

    const removal = await context.request.delete(`/api/workspaces/${encodeURIComponent(isolated!.id)}?terminate=true`);
    expect(removal.ok()).toBe(true);
    expect((await gitWorkspace('worktree', 'list', '--porcelain')).match(/^worktree /gm)).toHaveLength(1);
    expect(
      await realpath(dirname(isolated!.cwd)).then(
        () => true,
        () => false
      )
    ).toBe(false);
    expect((await gitWorkspace('branch', '--list', isolated!.worktreeBranch!)).trim()).toContain(
      isolated!.worktreeBranch!
    );
  } finally {
    const workspacesResponse = await context.request.get('/api/workspaces').catch(() => undefined);
    if (workspacesResponse?.ok()) {
      const workspacesBody = (await workspacesResponse.json()) as { workspaces: ManagedWorkspace[] };
      for (const workspace of workspacesBody.workspaces.filter((candidate) => candidate.worktreeBranch)) {
        await removeWorkspace(context, workspace.id);
        await gitWorkspace('worktree', 'remove', '--force', workspace.cwd).catch(() => undefined);
        await gitWorkspace('branch', '-D', workspace.worktreeBranch!).catch(() => undefined);
        await rm(dirname(workspace.cwd), { recursive: true, force: true });
      }
    }
    if (isolatedBranch) await gitWorkspace('branch', '-D', isolatedBranch).catch(() => undefined);
    await rm(gitDirectory, { recursive: true, force: true });
    await writeFile(trackedFile, 'initial browser test content\n', 'utf8');
  }
});

test('shares workspace aliases and manual order across devices', async ({ browser }) => {
  test.setTimeout(45_000);
  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();
  let firstWorkspace: ManagedWorkspace | undefined;
  let secondWorkspace: ManagedWorkspace | undefined;
  try {
    await authenticate(firstContext);
    await authenticate(secondContext);
    firstWorkspace = await createWorkspace(firstContext);
    secondWorkspace = await createWorkspace(firstContext);
    const betaResponse = await firstContext.request.put(
      `/api/workspaces/${encodeURIComponent(secondWorkspace.id)}/alias`,
      {
        data: { alias: 'Beta' },
      }
    );
    expect(betaResponse.ok()).toBe(true);

    const firstPage = await firstContext.newPage();
    const secondPage = await secondContext.newPage();
    await secondPage.goto('/');
    await expect(secondPage.locator('.workspace-title strong', { hasText: 'Beta' })).toBeVisible();

    await firstPage.goto(`/workspaces/${encodeURIComponent(firstWorkspace.id)}`);
    await expectTerminalReady(firstPage);
    await firstPage.locator('.workspace-row-shell.selected .workspace-actions-menu .vampire-menu-trigger').click();
    await firstPage.getByRole('menuitem', { name: 'Set workspace alias' }).click();
    await firstPage.getByRole('textbox', { name: 'Alias' }).fill('Alpha');
    await firstPage.getByRole('button', { name: 'Save alias' }).click();
    await expect(firstPage.locator('.terminal-identity-title strong')).toHaveText('Alpha');
    await expect(secondPage.locator('.workspace-title strong', { hasText: 'Alpha' })).toBeVisible({ timeout: 12_000 });

    await firstPage.getByRole('button', { name: 'Arrange workspaces manually' }).click();
    await expect(secondPage.getByRole('button', { name: 'Arrange workspaces manually' })).toHaveAttribute(
      'aria-pressed',
      'true',
      { timeout: 12_000 }
    );
    const alphaRow = firstPage.locator('.workspace-row-shell', { hasText: 'Alpha' });
    await alphaRow.locator('.workspace-row').press('Alt+ArrowDown');
    await expect(firstPage.locator('.workspace-title strong')).toHaveText(['Beta', 'Alpha']);
    await expect(secondPage.locator('.workspace-title strong')).toHaveText(['Beta', 'Alpha'], { timeout: 12_000 });

    await secondPage.reload();
    await expect(secondPage.getByRole('button', { name: 'Arrange workspaces manually' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await expect(secondPage.locator('.workspace-title strong')).toHaveText(['Beta', 'Alpha']);
  } finally {
    await removeWorkspace(firstContext, firstWorkspace?.id);
    await removeWorkspace(firstContext, secondWorkspace?.id);
    await Promise.all([firstContext.close(), secondContext.close()]);
  }
});

test('keeps the new workspace dialog header fixed while browsing folders', async ({ context, page }) => {
  await authenticate(context);
  await page.route('**/api/workspace-directories*', async (route) => {
    const directories = Array.from({ length: 80 }, (_, index) => ({
      name: `folder-${String(index + 1).padStart(2, '0')}`,
      path: `/workspace/folder-${String(index + 1).padStart(2, '0')}`,
    }));
    await route.fulfill({
      json: {
        roots: [{ id: 'root', label: 'Workspace', path: '/workspace' }],
        current: { rootId: 'root', label: 'Workspace', path: '/workspace' },
        parentPath: null,
        directories,
        truncated: true,
      },
    });
  });

  await page.setViewportSize({ width: 412, height: 640 });
  await page.goto('/');
  await page.locator('.new-workspace-toggle').click();
  const dialog = page.getByRole('dialog', { name: 'Open a project' });
  const body = dialog.locator('.vampire-dialog-body');
  const header = dialog.locator('.vampire-dialog-header');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: /folder-80/ })).toBeVisible();

  const before = await header.boundingBox();
  const scrollInfo = await body.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    return {
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      scrollTop: element.scrollTop,
    };
  });
  const after = await header.boundingBox();
  expect(scrollInfo.scrollHeight).toBeGreaterThan(scrollInfo.clientHeight);
  expect(scrollInfo.scrollTop).toBeGreaterThan(0);
  expect(before).not.toBeNull();
  expect(after).not.toBeNull();
  expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThan(1);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
});

test('reconnects the terminal after a transient WebSocket close', async ({ context, page }) => {
  await authenticate(context);
  const workspace = await createWorkspace(context);
  workspaceId = workspace.id;

  let firstConnection: WebSocketRoute | undefined;
  let resolveFirstConnection!: () => void;
  let resolveSecondConnection!: () => void;
  const firstConnectionOpened = new Promise<void>((resolve) => {
    resolveFirstConnection = resolve;
  });
  const secondConnectionOpened = new Promise<void>((resolve) => {
    resolveSecondConnection = resolve;
  });
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

  await page.goto(`/workspaces/${encodeURIComponent(workspace.id)}`);
  await firstConnectionOpened;
  await expectTerminalReady(page);
  await firstConnection!.close({ code: 1012, reason: 'browser test restart' });

  await expect(page.locator('.terminal-connection-status')).toContainText('Reconnecting to terminal…');
  await secondConnectionOpened;
  await expect(page.getByText('Reconnecting to terminal…')).toBeHidden({ timeout: 15_000 });
  await expectTerminalReady(page);
  expect(connectionCount).toBe(2);
});

test('loads retained terminal history only after an upward scroll', async ({ context, page }) => {
  await authenticate(context);
  const workspace = await createWorkspace(context);
  workspaceId = workspace.id;
  await fillTerminalWithNumberedRows(workspace.tmuxSession, 900);
  const messages: ObservedTerminalMessage[] = [];
  await observeTerminalMessages(page, messages);

  await page.goto(`/workspaces/${encodeURIComponent(workspace.id)}`);
  await expectTerminalReady(page);
  await expect
    .poll(() => messages.find((message) => message.direction === 'server' && message.type === 'snapshot'))
    .toMatchObject({ historyLoaded: 0 });
  const initialSnapshot = messages.find((message) => message.direction === 'server' && message.type === 'snapshot');
  expect(initialSnapshot?.historyAvailable).toBeGreaterThan(0);
  expect(initialSnapshot?.snapshotData?.split('\n').length).toBeLessThan(100);
  expect(initialSnapshot?.snapshotData).not.toContain('VAMP_ROW_001');
  expect(messages.some((message) => message.direction === 'client' && message.type === 'load-history')).toBe(false);

  const visibleNumberedRows = () =>
    page
      .locator('.xterm-rows > div')
      .allTextContents()
      .then((rows) =>
        rows
          .map((row) => /^VAMP_ROW_(\d+)$/u.exec(row.trim()))
          .filter((match): match is RegExpExecArray => Boolean(match))
          .map((match) => Number(match[1]))
      );
  const initialRows = await visibleNumberedRows();
  expect(initialRows.length).toBeGreaterThan(0);
  const initialMinimum = Math.min(...initialRows);

  await page.locator('.xterm-screen').hover();
  await page.mouse.wheel(0, -240);
  await expect
    .poll(() => messages.find((message) => message.direction === 'client' && message.type === 'load-history'))
    .toMatchObject({ lines: 500 });
  await expect
    .poll(() => messages.filter((message) => message.direction === 'server' && message.type === 'snapshot').at(-1))
    .toMatchObject({ historyLoaded: 500, historyAvailable: initialSnapshot?.historyAvailable });
  await expect
    .poll(async () => {
      const rows = await visibleNumberedRows();
      return rows.length > 0 ? Math.min(...rows) : initialMinimum;
    })
    .toBeLessThan(initialMinimum);

  for (let index = 0; index < 200; index += 1) await page.mouse.wheel(0, -240);
  await expect
    .poll(() => messages.filter((message) => message.direction === 'client' && message.type === 'load-history').length)
    .toBe(2);
  expect(
    messages
      .filter((message) => message.direction === 'client' && message.type === 'load-history')
      .map((message) => message.lines)
  ).toEqual([500, 1_000]);
  await expect
    .poll(() => messages.filter((message) => message.direction === 'server' && message.type === 'snapshot').at(-1))
    .toMatchObject({
      historyLoaded: initialSnapshot?.historyAvailable,
      historyAvailable: initialSnapshot?.historyAvailable,
    });
});

test('preserves alternate-screen row backgrounds after returning to a workspace', async ({ context, page }) => {
  await authenticate(context);
  const workspace = await createWorkspace(context);
  workspaceId = workspace.id;

  await page.goto(`/workspaces/${encodeURIComponent(workspace.id)}`);
  await expectTerminalReady(page);
  const command =
    "printf '\\033[?1049h\\033[2J\\033[H\\033[1;1H\\033[48;2;60;60;60m\\033[2K\\033[1;20H\\033[38;2;240;240;240mtop-background\\033[0m\\033[4;1H\\033[48;2;60;60;60m\\033[2K\\033[4;20H\\033[38;2;240;240;240mmiddle-background\\033[0m\\033[8;1H\\033[48;2;60;60;60m\\033[2K\\033[8;20H\\033[38;2;240;240;240mbottom-background\\033[0m'";
  await run('tmux', ['send-keys', '-t', workspace.tmuxSession, '-l', '--', command]);
  await run('tmux', ['send-keys', '-t', workspace.tmuxSession, 'C-m']);
  await expect
    .poll(async () =>
      (await tmuxPaneRows(workspace.tmuxSession)).some(
        (row) => row.includes('top-background') && !row.includes('printf')
      )
    )
    .toBe(true);
  await expect(page.locator('.xterm-rows')).toContainText('top-background');
  await expect(page.locator('.xterm-rows')).toContainText('middle-background');
  await expect(page.locator('.xterm-rows')).toContainText('bottom-background');
  await page.waitForTimeout(600);
  const backgroundRows = [0, 3, 7].map((row) => page.locator('.xterm-rows > div').nth(row));
  const before = await Promise.all(backgroundRows.map((row) => row.innerHTML()));
  for (const row of before) expect(row).toContain('background-color:#3c3c3c');

  await page.goto('/');
  await page.goto(`/workspaces/${encodeURIComponent(workspace.id)}`);
  await expectTerminalReady(page);
  await expect(page.locator('.xterm-rows')).toContainText('top-background');
  await expect(page.locator('.xterm-rows')).toContainText('middle-background');
  await expect(page.locator('.xterm-rows')).toContainText('bottom-background');
  await page.waitForTimeout(600);
  const after = await Promise.all(backgroundRows.map((row) => row.innerHTML()));
  expect(after).toEqual(before);
});

test('keeps geometry messages away from a pre-geometry browser tab', async ({ context, page }) => {
  await authenticate(context);
  const workspace = await createWorkspace(context);
  workspaceId = workspace.id;
  await page.goto('/');

  const messageTypes = await page.evaluate(
    ({ id, terminalId }) =>
      new Promise<string[]>((resolve, reject) => {
        const url = new URL('/ws/terminal', location.href);
        url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        url.searchParams.set('workspace', id);
        if (terminalId) url.searchParams.set('terminal', terminalId);
        const socket = new WebSocket(url);
        const types: string[] = [];
        const timer = window.setTimeout(() => {
          socket.close();
          reject(new Error('compatibility terminal connection timed out'));
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
          reject(new Error('compatibility terminal connection failed'));
        };
      }),
    { id: workspace.id, terminalId: workspace.terminals[0]?.id }
  );

  expect(messageTypes).toContain('snapshot');
  expect(messageTypes).toContain('screen-ready');
  expect(messageTypes).not.toContain('geometry');
});

test('ignores transient terminal container collapse until a usable size returns', async ({ context, page }) => {
  await authenticate(context);
  const workspace = await createWorkspace(context);
  workspaceId = workspace.id;

  await page.goto(`/workspaces/${encodeURIComponent(workspace.id)}`);
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
  await run('tmux', ['send-keys', '-t', workspace.tmuxSession, '-l', '--', "printf 'stable-terminal-size\\n'"]);
  await run('tmux', ['send-keys', '-t', workspace.tmuxSession, 'Enter']);
  await expect(terminal.locator('.xterm-rows')).toContainText('stable-terminal-size');
});

test('keeps the desktop font default on a wide touch display', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    hasTouch: true,
  });
  let createdWorkspaceId: string | undefined;
  try {
    await authenticate(context);
    const workspace = await createWorkspace(context);
    createdWorkspaceId = workspace.id;
    const page = await context.newPage();
    await page.goto(`/workspaces/${encodeURIComponent(workspace.id)}`);
    await expectTerminalReady(page);
    const fontSize = await page
      .getByRole('application', { name: 'Interactive shell terminal' })
      .locator('.xterm-rows')
      .evaluate((rows) => getComputedStyle(rows).fontSize);
    expect(fontSize).toBe('14px');
  } finally {
    await removeWorkspace(context, createdWorkspaceId);
    await context.close();
  }
});

test('does not treat another device terminal redraw as main-workspace output', async ({ browser }) => {
  test.setTimeout(60_000);
  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();
  let createdWorkspace: Awaited<ReturnType<typeof createWorkspace>> | undefined;
  try {
    await authenticate(firstContext);
    await authenticate(secondContext);
    createdWorkspace = await createWorkspace(firstContext);
    const firstPage = await firstContext.newPage();
    const secondPage = await secondContext.newPage();

    await firstPage.goto(`/workspaces/${encodeURIComponent(createdWorkspace.id)}`);
    await expectTerminalReady(firstPage);
    await expect(firstPage.locator('.workspace-row-shell.selected .workspace-state')).toHaveCount(0);
    await firstPage.getByRole('button', { name: 'Arrange workspaces manually' }).click();
    const firstState = firstPage.locator('.workspace-row-shell.selected .workspace-state');
    await expect(firstState).toHaveText('Idle');
    await firstPage.evaluate(() => {
      window.__vampireObservedWorkspaceStates = [];
      window.__vampireWorkspaceStateTimer = window.setInterval(() => {
        const state = document.querySelector('.workspace-row-shell.selected .workspace-state')?.textContent?.trim();
        if (state) window.__vampireObservedWorkspaceStates.push(state);
      }, 40);
    });

    await secondPage.goto(`/workspaces/${encodeURIComponent(createdWorkspace.id)}`);
    await expectTerminalReady(secondPage);
    await firstPage.waitForTimeout(2_000);
    const observedStates = await firstPage.evaluate(() => {
      window.clearInterval(window.__vampireWorkspaceStateTimer);
      return window.__vampireObservedWorkspaceStates;
    });
    expect(observedStates).not.toContain('Working');
    expect(observedStates).not.toContain('Review');

    await firstPage.goto('/');
    const workspaceState = firstPage.locator('.workspace-row', { hasText: 'workspace' }).locator('.workspace-state');
    await expect(workspaceState).toHaveText('Idle');
    await firstPage.waitForTimeout(8_200);
    await expect(workspaceState).toHaveText('Idle');
  } finally {
    await removeWorkspace(firstContext, createdWorkspace?.id);
    await Promise.all([firstContext.close(), secondContext.close()]);
  }
});

test('publishes output sent immediately after terminal resize to other devices', async ({ browser }) => {
  test.setTimeout(45_000);
  const observerContext = await browser.newContext();
  const controllerContext = await browser.newContext();
  let createdWorkspace: Awaited<ReturnType<typeof createWorkspace>> | undefined;
  try {
    await authenticate(observerContext);
    await authenticate(controllerContext);
    createdWorkspace = await createWorkspace(observerContext);
    const observerPage = await observerContext.newPage();
    const controllerPage = await controllerContext.newPage();

    await observerPage.goto('/');
    await expect(observerPage.locator('.workspace-row', { hasText: 'workspace' })).toBeVisible();
    await observerPage.getByRole('button', { name: 'Arrange workspaces manually' }).click();
    const observerState = observerPage.locator('.workspace-row', { hasText: 'workspace' }).locator('.workspace-state');
    await expect(observerState).toHaveText('Idle');

    await controllerPage.goto(`/workspaces/${encodeURIComponent(createdWorkspace.id)}`);
    await expectTerminalReady(controllerPage);
    const composer = controllerPage.getByPlaceholder('Send to shell…');
    await composer.fill("printf 'immediate-resize-output\\n'");
    await composer.press('Enter');

    await expect(observerState).toHaveText('Working', { timeout: 3_000 });
  } finally {
    await removeWorkspace(observerContext, createdWorkspace?.id);
    await Promise.all([observerContext.close(), controllerContext.close()]);
  }
});

test('restores a pending-autowrap cursor before the next terminal character', async ({ browser }) => {
  test.setTimeout(45_000);
  const firstContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const secondContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  let createdWorkspace: Awaited<ReturnType<typeof createWorkspace>> | undefined;
  try {
    await authenticate(firstContext);
    await authenticate(secondContext);
    createdWorkspace = await createWorkspace(firstContext);
    const firstPage = await firstContext.newPage();
    const secondPage = await secondContext.newPage();
    await firstPage.goto(`/workspaces/${encodeURIComponent(createdWorkspace.id)}`);
    await expectTerminalReady(firstPage);
    const geometry = await tmuxPaneGeometry(createdWorkspace.tmuxSession);
    const fullRow = 'W'.repeat(geometry.columns);
    const firstComposer = firstPage.getByPlaceholder('Send to shell…');
    await firstComposer.fill(`printf '${fullRow}'; IFS= read -r value; printf '\\nVAMP_WRAP_INPUT=%s\\n' "$value"`);
    await firstComposer.press('Enter');
    await expect.poll(() => tmuxPaneCursor(createdWorkspace!.tmuxSession)).toMatchObject({ column: geometry.columns });

    await secondPage.goto(`/workspaces/${encodeURIComponent(createdWorkspace.id)}`);
    await expectTerminalReady(secondPage);
    await expect.poll(() => tmuxPaneGeometry(createdWorkspace!.tmuxSession)).toEqual(geometry);
    await expectTerminalRowsMatchTmux(createdWorkspace.tmuxSession, firstPage, secondPage);
    const secondComposer = secondPage.getByPlaceholder('Send to shell…');
    await secondComposer.fill('Z');
    await secondComposer.press('Enter');
    await expect
      .poll(async () => (await tmuxPaneRows(createdWorkspace!.tmuxSession)).some((row) => row === 'VAMP_WRAP_INPUT=Z'))
      .toBe(true);
    await expectTerminalRowsMatchTmux(createdWorkspace.tmuxSession, firstPage, secondPage);
  } finally {
    await removeWorkspace(firstContext, createdWorkspace?.id);
    await Promise.all([firstContext.close(), secondContext.close()]);
  }
});

test('offers layout takeover when another same-sized device has control', async ({ browser }) => {
  const firstContext = await browser.newContext({ viewport: { width: 1_000, height: 700 } });
  const secondContext = await browser.newContext({ viewport: { width: 1_000, height: 700 } });
  let createdWorkspace: Awaited<ReturnType<typeof createWorkspace>> | undefined;
  try {
    await authenticate(firstContext);
    await authenticate(secondContext);
    createdWorkspace = await createWorkspace(firstContext);
    const firstPage = await firstContext.newPage();
    const secondPage = await secondContext.newPage();
    await firstPage.goto(`/workspaces/${encodeURIComponent(createdWorkspace.id)}`);
    await expectTerminalReady(firstPage);
    const geometry = await tmuxPaneGeometry(createdWorkspace.tmuxSession);

    await secondPage.goto(`/workspaces/${encodeURIComponent(createdWorkspace.id)}`);
    await expectTerminalReady(secondPage);
    await expect.poll(() => tmuxPaneGeometry(createdWorkspace!.tmuxSession)).toEqual(geometry);
    const firstTakeover = firstPage.getByRole('button', { name: 'Use this device' });
    const secondTakeover = secondPage.getByRole('button', { name: 'Use this device' });
    await expect(firstTakeover).toBeVisible();
    await expect(secondTakeover).toBeHidden();

    await firstTakeover.click();
    await expect(firstTakeover).toBeHidden();
    await expect(secondTakeover).toBeVisible();
  } finally {
    await removeWorkspace(firstContext, createdWorkspace?.id);
    await Promise.all([firstContext.close(), secondContext.close()]);
  }
});

test('hands terminal layout between entered devices and restores it on disconnect', async ({ browser }) => {
  test.setTimeout(60_000);
  const desktopContext = await browser.newContext({ viewport: { width: 2_560, height: 1_400 } });
  const phoneContext = await browser.newContext({ viewport: { width: 480, height: 560 } });
  let createdWorkspace: Awaited<ReturnType<typeof createWorkspace>> | undefined;
  try {
    await authenticate(desktopContext);
    await authenticate(phoneContext);
    createdWorkspace = await createWorkspace(desktopContext);
    await fillTerminalWithNumberedRows(createdWorkspace.tmuxSession);
    const desktopPage = await desktopContext.newPage();
    const phonePage = await phoneContext.newPage();
    await desktopPage.addInitScript(() => {
      Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true });
    });
    await phonePage.addInitScript(() => {
      Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true });
    });

    await desktopPage.goto(`/workspaces/${encodeURIComponent(createdWorkspace.id)}`);
    await expectTerminalReady(desktopPage);
    const desktopRows = await desktopPage.locator('.xterm-rows').evaluate((rows) => rows.childElementCount);
    await expect.poll(async () => (await tmuxPaneGeometry(createdWorkspace!.tmuxSession)).rows).toBe(desktopRows);
    const desktopGeometry = await tmuxPaneGeometry(createdWorkspace.tmuxSession);
    expect(desktopGeometry.columns).toBeGreaterThan(240);
    const initialDesktopRender = await renderedTerminalGeometry(desktopPage);
    expect(initialDesktopRender.screenWidth).toBeLessThanOrEqual(initialDesktopRender.containerWidth);
    await expectTerminalRowsMatchTmux(createdWorkspace.tmuxSession, desktopPage);
    const desktopComposer = desktopPage.getByPlaceholder('Send to shell…');
    const alternateScreenCommand =
      "printf '\\033[?1049h\\033[2J\\033[8;20HVAMP_TUI_READY\\033[12;7H'; IFS= read -r value; printf '\\033[?1049lVAMP_TUI_INPUT=%s\\n' \"$value\"";
    await desktopComposer.fill(alternateScreenCommand);
    await desktopComposer.press('Enter');
    await expect
      .poll(async () =>
        (await tmuxPaneRows(createdWorkspace!.tmuxSession)).some((row) => row.includes('VAMP_TUI_READY'))
      )
      .toBe(true);
    await expectTerminalRowsMatchTmux(createdWorkspace.tmuxSession, desktopPage);

    await phonePage.goto(`/workspaces/${encodeURIComponent(createdWorkspace.id)}`);
    await expectTerminalReady(phonePage);
    await expect
      .poll(async () => (await tmuxPaneGeometry(createdWorkspace!.tmuxSession)).rows)
      .toBeLessThan(desktopGeometry.rows);
    const phoneGeometry = await tmuxPaneGeometry(createdWorkspace.tmuxSession);
    await expect
      .poll(() => desktopPage.locator('.xterm-rows').evaluate((rows) => rows.childElementCount))
      .toBe(phoneGeometry.rows);
    await expect.poll(() => renderedTerminalGeometry(phonePage)).toMatchObject({ rows: phoneGeometry.rows });
    const phoneRender = await renderedTerminalGeometry(phonePage);
    expect(phoneRender.screenWidth).toBeLessThanOrEqual(phoneRender.containerWidth);
    await expectTerminalRowsMatchTmux(createdWorkspace.tmuxSession, desktopPage, phonePage);
    const desktopHandoff = desktopPage.getByText('Sized for another device');
    const phoneHandoff = phonePage.getByText('Sized for another device');
    await expect(desktopHandoff).toBeVisible();
    await expect(phoneHandoff).toBeHidden();
    const phoneComposer = phonePage.getByPlaceholder('Send to shell…');
    await phoneComposer.fill('VAMP_TUI_MOBILE_INPUT');
    await phoneComposer.press('Enter');
    await expect
      .poll(async () =>
        (await tmuxPaneRows(createdWorkspace!.tmuxSession)).some(
          (row) => row === 'VAMP_TUI_INPUT=VAMP_TUI_MOBILE_INPUT'
        )
      )
      .toBe(true);
    await expectTerminalRowsMatchTmux(createdWorkspace.tmuxSession, desktopPage, phonePage);

    await desktopPage.getByRole('button', { name: 'Use this device' }).click();
    await expect.poll(async () => (await tmuxPaneGeometry(createdWorkspace!.tmuxSession)).columns).toBeGreaterThan(240);
    await expect
      .poll(async () => (await tmuxPaneGeometry(createdWorkspace!.tmuxSession)).rows)
      .toBe(desktopGeometry.rows);
    const restoredDesktopGeometry = await tmuxPaneGeometry(createdWorkspace.tmuxSession);
    await expect(desktopHandoff).toBeHidden();
    await expect(phoneHandoff).toBeVisible();
    await expectTerminalRowsMatchTmux(createdWorkspace.tmuxSession, desktopPage, phonePage);

    await phonePage.getByRole('button', { name: 'Use this device' }).click();
    await expect.poll(() => tmuxPaneGeometry(createdWorkspace!.tmuxSession)).toEqual(phoneGeometry);
    await expect(desktopHandoff).toBeVisible();
    await expect(phoneHandoff).toBeHidden();
    await expectTerminalRowsMatchTmux(createdWorkspace.tmuxSession, desktopPage, phonePage);
    await phoneComposer.fill("printf 'VAMP_AFTER_PHONE_HANDOFF\\n'");
    await phoneComposer.press('Enter');
    await expect
      .poll(async () =>
        (await tmuxPaneRows(createdWorkspace!.tmuxSession)).some((row) => row === 'VAMP_AFTER_PHONE_HANDOFF')
      )
      .toBe(true);
    await expectTerminalRowsMatchTmux(createdWorkspace.tmuxSession, desktopPage, phonePage);

    await phonePage.close();
    await expect.poll(() => tmuxPaneGeometry(createdWorkspace!.tmuxSession)).toEqual(restoredDesktopGeometry);
    await expect(desktopHandoff).toBeHidden();
    await expect
      .poll(() => desktopPage.locator('.xterm-rows').evaluate((rows) => rows.childElementCount))
      .toBe(restoredDesktopGeometry.rows);
    const restoredDesktopRender = await renderedTerminalGeometry(desktopPage);
    expect(restoredDesktopRender.screenWidth).toBeLessThanOrEqual(restoredDesktopRender.containerWidth);
    await expectTerminalRowsMatchTmux(createdWorkspace.tmuxSession, desktopPage);
    await desktopComposer.fill("printf 'VAMP_AFTER_DESKTOP_RESTORE\\n'");
    await desktopComposer.press('Enter');
    await expect
      .poll(async () =>
        (await tmuxPaneRows(createdWorkspace!.tmuxSession)).some((row) => row === 'VAMP_AFTER_DESKTOP_RESTORE')
      )
      .toBe(true);
    await expectTerminalRowsMatchTmux(createdWorkspace.tmuxSession, desktopPage);
  } finally {
    await removeWorkspace(desktopContext, createdWorkspace?.id);
    await Promise.all([desktopContext.close(), phoneContext.close()]);
  }
});

test('re-reports each device theme whenever terminal control changes', async ({ browser }) => {
  test.setTimeout(60_000);
  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();
  let createdWorkspace: Awaited<ReturnType<typeof createWorkspace>> | undefined;
  try {
    await authenticate(firstContext);
    await authenticate(secondContext);
    createdWorkspace = await createWorkspace(firstContext);
    const firstPage = await firstContext.newPage();
    const secondPage = await secondContext.newPage();
    await firstPage.addInitScript(() => window.localStorage.setItem('vampire:theme', 'light'));
    await secondPage.addInitScript(() => window.localStorage.setItem('vampire:theme', 'dark'));
    const firstMessages: ObservedTerminalMessage[] = [];
    const secondMessages: ObservedTerminalMessage[] = [];
    await observeTerminalMessages(firstPage, firstMessages);
    await observeTerminalMessages(secondPage, secondMessages);

    await firstPage.goto(`/workspaces/${encodeURIComponent(createdWorkspace.id)}`);
    await expectTerminalReady(firstPage);
    await expect.poll(() => reportedThemeAfterLatestRequest(firstMessages)).toBe(true);
    const firstRequestCount = firstMessages.filter(
      (message) => message.direction === 'server' && message.type === 'request-terminal-theme'
    ).length;

    await secondPage.goto(`/workspaces/${encodeURIComponent(createdWorkspace.id)}`);
    await expectTerminalReady(secondPage);
    await expect.poll(() => reportedThemeAfterLatestRequest(secondMessages)).toBe(true);

    await secondPage.close();
    await expect
      .poll(
        () =>
          firstMessages.filter((message) => message.direction === 'server' && message.type === 'request-terminal-theme')
            .length
      )
      .toBe(firstRequestCount + 1);
    await expect.poll(() => reportedThemeAfterLatestRequest(firstMessages)).toBe(true);
  } finally {
    await removeWorkspace(firstContext, createdWorkspace?.id);
    await Promise.all([firstContext.close(), secondContext.close()]);
  }
});

test('runs and stops a background command without replacing the main workspace', async ({ context, page }) => {
  test.setTimeout(60_000);
  await authenticate(context);
  const workspace = await createWorkspace(context);
  workspaceId = workspace.id;

  await page.goto(`/workspaces/${encodeURIComponent(workspace.id)}`);
  await expectTerminalReady(page);
  const composer = page.getByPlaceholder('Send to shell…');
  await composer.fill("printf 'main-workspace-marker\\n'");
  await composer.press('Enter');
  await expect(page.locator('.xterm-rows')).toContainText('main-workspace-marker');
  const mainWorkspaceProcess = await page.locator('.workspace-row-shell.selected .workspace-program').textContent();
  await expect(page.getByRole('tab')).toHaveCount(0);

  const backgroundTrigger = page.getByRole('button', { name: 'Open background processes' });
  await backgroundTrigger.click();
  const backgroundDialog = page.getByRole('dialog');
  await expect(backgroundDialog).toBeVisible();
  await backgroundDialog.getByRole('button', { name: 'Run background command' }).click();
  const backgroundCommand = backgroundDialog.getByRole('textbox', { name: 'Background command' });
  const longCommand = "printf 'background-process-marker\\n'; sleep 30";
  await backgroundCommand.fill(longCommand);
  await backgroundDialog.getByRole('button', { name: 'Run', exact: true }).click();
  const backgroundOutput = backgroundDialog.getByRole('region', { name: `Output for ${longCommand}` }).locator('pre');
  await expect(backgroundOutput).toContainText('background-process-marker', { timeout: 10_000 });
  await expect(page.locator('.xterm-rows')).toContainText('main-workspace-marker');
  await expect(page.locator('.xterm-rows')).not.toContainText('background-process-marker');
  await expect(page.locator('.workspace-row-shell.selected .workspace-program')).toHaveText(
    mainWorkspaceProcess || 'zsh'
  );
  await expect(page.locator('.workspace-row-shell.selected .runtime-summary')).toHaveText('1 background');
  await expect(page.locator('.workspace-group.idle .workspace-row-shell.selected')).toBeVisible({ timeout: 12_000 });
  await backgroundDialog.getByRole('button', { name: `Save ${longCommand} as favorite`, exact: true }).click();
  await backgroundDialog.getByRole('button', { name: 'Back to background processes' }).click();
  await expect(
    backgroundDialog.getByRole('button', { name: `Run favorite ${longCommand}`, exact: true })
  ).toBeVisible();

  await page.reload();
  await expectTerminalReady(page);
  await page.getByRole('button', { name: 'Open background processes' }).click();
  await expect(
    backgroundDialog.getByRole('button', { name: `Run favorite ${longCommand}`, exact: true })
  ).toBeVisible();
  const outputRoute = '**/api/workspaces/*/background/*/output';
  await page.route(outputRoute, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    await route.continue();
  });
  await backgroundDialog.getByRole('button', { name: `View output for ${longCommand}`, exact: true }).click();
  await expect(backgroundDialog.getByRole('region', { name: `Output for ${longCommand}` })).toBeVisible();
  await backgroundDialog.getByRole('button', { name: 'Close background manager' }).click();
  await expect(backgroundDialog).toBeHidden();
  await composer.fill("for i in {1..24}; do printf 'main-output-churn\\n'; sleep 0.4; done");
  await composer.press('Enter');
  await backgroundTrigger.click();
  await backgroundDialog.getByRole('button', { name: `View output for ${longCommand}`, exact: true }).click();
  const delayedOutput = backgroundDialog.locator('.process-output');
  await expect(delayedOutput.locator('pre')).toContainText('background-process-marker', { timeout: 10_000 });
  const returnedToLoading = await delayedOutput.evaluate(async (output) => {
    let loadingObserved = Boolean(output.querySelector('.output-placeholder'));
    const observer = new MutationObserver(() => {
      if (output.querySelector('.output-placeholder')) loadingObserved = true;
    });
    observer.observe(output, {
      characterData: true,
      childList: true,
      subtree: true,
    });
    await new Promise((resolve) => window.setTimeout(resolve, 4_000));
    observer.disconnect();
    return loadingObserved;
  });
  expect(returnedToLoading).toBe(false);
  await page.unrouteAll({ behavior: 'wait' });

  await backgroundDialog.getByRole('button', { name: `Stop ${longCommand}`, exact: true }).click();
  await expect(
    backgroundDialog.getByRole('button', { name: `View output for ${longCommand}`, exact: true })
  ).toHaveCount(0);
  await expect(page.locator('.workspace-row-shell.selected .runtime-summary')).toBeHidden();
  await backgroundDialog.getByRole('button', { name: `Run favorite ${longCommand}`, exact: true }).click();
  await expect(backgroundDialog.getByRole('region', { name: `Output for ${longCommand}` })).toBeVisible({
    timeout: 15_000,
  });
  await backgroundDialog.getByRole('button', { name: `Stop ${longCommand}`, exact: true }).click();
  await expect(
    backgroundDialog.getByRole('button', { name: `View output for ${longCommand}`, exact: true })
  ).toHaveCount(0);
  await backgroundDialog.getByRole('button', { name: `Remove ${longCommand} from favorites`, exact: true }).click();
  await expect(backgroundDialog.getByRole('button', { name: `Run favorite ${longCommand}`, exact: true })).toHaveCount(
    0
  );

  await backgroundDialog.getByRole('button', { name: 'Run background command' }).click();
  await backgroundCommand.fill("printf 'finished-background-marker\\n'");
  await backgroundDialog.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(backgroundDialog.locator('.process-output pre')).toContainText('finished-background-marker');
  await backgroundDialog.getByRole('button', { name: 'Back to background processes' }).click();
  const finishedRows = backgroundDialog.locator('.process-row', { hasText: 'finished-background-marker' });
  await expect(finishedRows).toHaveCount(1);
  const rerunFinishedCommand = finishedRows.first().getByRole('button', { name: /Run printf.*again/ });
  await expect(rerunFinishedCommand).toBeVisible({ timeout: 10_000 });
  await rerunFinishedCommand.click();
  await expect(backgroundDialog.getByRole('button', { name: 'Back to background processes' })).toBeVisible();
  await backgroundDialog.getByRole('button', { name: 'Back to background processes' }).click();
  await expect(finishedRows).toHaveCount(2, { timeout: 10_000 });

  await page.reload();
  await expectTerminalReady(page);
  await page.getByRole('button', { name: 'Open background processes' }).click();
  await expect(backgroundDialog.locator('.favorite-strip')).toHaveCount(0);
  await expect(backgroundDialog.locator('.favorite-command')).toHaveCount(0);
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
  const workspace = await createWorkspace(context);
  workspaceId = workspace.id;

  await page.goto('/');
  const workspaceRow = page.locator('.workspace-row', { hasText: 'workspace' });
  await expect(workspaceRow).toBeVisible();
  await expect(workspaceRow.locator('.workspace-state')).toHaveCount(0);
  await page.getByRole('button', { name: 'Arrange workspaces manually' }).click();
  await expect(workspaceRow.locator('.workspace-state')).toHaveText('Idle');
  await page.getByRole('button', { name: 'Group workspaces by status' }).click();
  await expect(workspaceRow.locator('.workspace-state')).toHaveCount(0);
  await page.waitForTimeout(1_100);
  await run('tmux', ['send-keys', '-t', workspace.tmuxSession, '-l', '--', "printf 'vampire activity check\\n'"]);
  await run('tmux', ['send-keys', '-t', workspace.tmuxSession, 'Enter']);

  await expect(page.locator('.workspace-group.working .workspace-row', { hasText: 'workspace' })).toBeVisible({
    timeout: 3_000,
  });
  await expect(page.locator('.workspace-group.review .workspace-row', { hasText: 'workspace' })).toBeVisible({
    timeout: 12_000,
  });
  await page.reload();
  await expect(page.locator('.workspace-group.review .workspace-row', { hasText: 'workspace' })).toBeVisible();
  await workspaceRow.click();
  await expectTerminalReady(page);
  await expect(page.locator('.workspace-group.idle .workspace-row', { hasText: 'workspace' })).toBeVisible();

  await run('tmux', ['kill-session', '-t', workspace.tmuxSession]);
  const endedGroup = page.locator('.workspace-group.ended');
  await expect(endedGroup.getByRole('button', { name: /Ended/ })).toHaveAttribute('aria-expanded', 'true', {
    timeout: 3_000,
  });
  await expect(endedGroup.locator('.workspace-row', { hasText: 'workspace' })).toBeVisible();
});

test('resizes the terminal area when opening the repository panel', async ({ context, page }) => {
  await authenticate(context);
  const workspace = await createWorkspace(context);
  workspaceId = workspace.id;

  await page.goto(`/workspaces/${encodeURIComponent(workspace.id)}`);
  await expectTerminalReady(page);
  const terminalWidthBeforePanel = await page
    .locator('.workspace-primary')
    .evaluate((element) => element.getBoundingClientRect().width);
  await page.getByRole('button', { name: 'Open repository' }).click();
  const repositoryPanel = page.getByRole('complementary', { name: 'Repository for workspace' });
  await expect(repositoryPanel).toBeVisible();
  await expect
    .poll(() => page.locator('.workspace-primary').evaluate((element) => element.getBoundingClientRect().width))
    .toBeLessThan(terminalWidthBeforePanel - 300);
  await expect
    .poll(() => repositoryPanel.evaluate((element) => element.getBoundingClientRect().width))
    .toBeGreaterThan(300);
});

test('keeps an externally changed file when an editor save conflicts', async ({ context, page }) => {
  test.setTimeout(45_000);
  const conflictFile = join(E2E_WORKSPACE_DIRECTORY, 'conflict.txt');
  await writeFile(conflictFile, 'initial browser test content\n', 'utf8');
  await authenticate(context);
  const workspace = await createWorkspace(context);
  workspaceId = workspace.id;

  await page.goto(`/workspaces/${encodeURIComponent(workspace.id)}`);
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
    writeFile(moveConflictSource, 'move conflict source\n', 'utf8'),
  ]);
  await writeFile(join(E2E_WORKSPACE_DIRECTORY, 'conflict.txt'), 'initial browser test content\n', 'utf8');

  try {
    await authenticate(context);
    const workspace = await createWorkspace(context);
    workspaceId = workspace.id;
    await page.goto(`/workspaces/${encodeURIComponent(workspace.id)}`);
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
    await expect
      .poll(() =>
        readFile(movableFile, 'utf8').then(
          () => true,
          () => false
        )
      )
      .toBe(false);
    await expect(page.getByRole('button', { name: 'Open uploads/move-me.txt' })).toBeVisible();

    await dropWorkspaceEntry(folderShell, { path: 'move-conflict.txt', kind: 'file' });
    await expect(page.getByRole('heading', { name: 'An item already exists' })).toBeVisible();
    expect(await readFile(moveConflictTarget, 'utf8')).toBe('existing destination\n');
    expect(await readFile(moveConflictSource, 'utf8')).toBe('move conflict source\n');
    await page.getByRole('button', { name: 'Keep both' }).click();
    await expect(page.getByRole('heading', { name: 'An item already exists' })).toBeHidden();
    await expect.poll(() => readFile(renamedMoveTarget, 'utf8').catch(() => '')).toBe('move conflict source\n');
    await expect
      .poll(() =>
        readFile(moveConflictSource, 'utf8').then(
          () => true,
          () => false
        )
      )
      .toBe(false);
    expect(await readFile(moveConflictTarget, 'utf8')).toBe('existing destination\n');

    const chooserPromise = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Add workspace item' }).click();
    await page.getByRole('menuitem', { name: 'Choose files…' }).click();
    const chooser = await chooserPromise;
    await chooser.setFiles([
      { name: 'fresh-upload.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([0, 1, 2, 255]) },
      { name: 'conflict.txt', mimeType: 'text/plain', buffer: Buffer.from('uploaded conflict\n') },
    ]);

    await expect(page.getByRole('heading', { name: '1 file already exists' })).toBeVisible();
    await expect.poll(() => readFile(rootUpload).catch(() => Buffer.alloc(0))).toEqual(Buffer.from([0, 1, 2, 255]));
    expect(await readFile(join(E2E_WORKSPACE_DIRECTORY, 'conflict.txt'), 'utf8')).toBe(
      'initial browser test content\n'
    );
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
      rm(moveConflictSource, { force: true }),
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
    const workspace = await createWorkspace(context);
    workspaceId = workspace.id;
    await page.goto(`/workspaces/${encodeURIComponent(workspace.id)}`);
    await expectTerminalReady(page);
    await page.getByRole('button', { name: 'Open repository' }).click();
    await page.getByRole('tab', { name: 'Changes' }).click();

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
    await expect
      .poll(() =>
        readFile(untrackedFile, 'utf8').then(
          () => true,
          () => false
        )
      )
      .toBe(false);
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
    const workspace = await createWorkspace(context);
    workspaceId = workspace.id;
    await page.route('**/api/workspaces/*/repository/file?*', async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('path') !== 'slow-open.txt') {
        await route.continue();
        return;
      }
      targetRequests += 1;
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      await route.continue().catch(() => undefined);
    });

    await page.goto(`/workspaces/${encodeURIComponent(workspace.id)}`);
    await expectTerminalReady(page);
    await page.getByRole('button', { name: 'Open repository' }).click();
    await expect(page.getByRole('complementary', { name: 'Repository for workspace' })).toHaveCSS(
      'transition-duration',
      '0s'
    );
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
    await Promise.all([rm(targetFile, { force: true }), rm(churnFile, { force: true })]);
  }
});
