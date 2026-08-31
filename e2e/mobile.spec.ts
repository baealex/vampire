import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, test, type WebSocketRoute } from '@playwright/test';
import {
  authenticate,
  createWorkspace,
  expectTerminalReady,
  removeWorkspace,
  resetWorkspaces,
  resetStatusPlugins,
} from './support.ts';

let workspaceId: string | undefined;
const run = promisify(execFile);

function websocketMessageType(message: string | Buffer): string | undefined {
  try {
    const value = JSON.parse(message.toString()) as { type?: unknown };
    return typeof value.type === 'string' ? value.type : undefined;
  } catch {
    return undefined;
  }
}

test.beforeEach(async ({ request }) => {
  workspaceId = undefined;
  await Promise.all([resetWorkspaces(request), resetStatusPlugins(request)]);
});

test.afterEach(async ({ context }) => {
  await removeWorkspace(context, workspaceId);
  workspaceId = undefined;
});

test('keeps a terminal connection failure inside the mobile viewport', async ({ context, page }) => {
  await authenticate(context);
  const workspace = await createWorkspace(context);
  workspaceId = workspace.id;
  await page.routeWebSocket(/\/ws\/terminal(?:\?|$)/, (socket) => {
    socket.close({ code: 1008, reason: 'authentication expired' });
  });

  await page.goto(`/workspaces/${encodeURIComponent(workspace.id)}`);
  const terminalFrame = page.locator('.terminal-frame');
  const connectionError = page.locator('.terminal-error');
  await expect(connectionError).toContainText('This terminal workspace is no longer authorized.');
  const [frameBox, errorBox] = await Promise.all([terminalFrame.boundingBox(), connectionError.boundingBox()]);
  expect(frameBox).not.toBeNull();
  expect(errorBox).not.toBeNull();
  expect(errorBox!.y).toBeGreaterThanOrEqual(frameBox!.y);
  expect(errorBox!.y + errorBox!.height).toBeLessThanOrEqual(frameBox!.y + frameBox!.height + 1);
  await expect(page.getByPlaceholder('Send to shell…')).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('keeps terminal IME input visible and focused while the mobile viewport resizes', async ({ context, page }) => {
  test.setTimeout(60_000);
  const sentTerminalMessages: Array<string | Buffer> = [];
  page.on('websocket', (socket) => {
    if (!new URL(socket.url()).pathname.endsWith('/ws/terminal')) return;
    socket.on('framesent', ({ payload }) => sentTerminalMessages.push(payload));
  });
  await authenticate(context);
  const workspace = await createWorkspace(context);
  workspaceId = workspace.id;

  await page.goto(`/workspaces/${encodeURIComponent(workspace.id)}`);
  await expectTerminalReady(page);
  const terminal = page.getByRole('application', { name: 'Interactive shell terminal' });
  await terminal.tap({ position: { x: 96, y: 96 } });
  const terminalInput = terminal.locator('.xterm-helper-textarea');
  const composition = terminal.locator('.composition-view');
  await expect(terminalInput).toBeFocused();

  await terminalInput.evaluate((input) => {
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
  });
  await expect(composition).toHaveClass(/active/);
  await page.waitForTimeout(50);
  sentTerminalMessages.length = 0;

  const updates = ['ㅁ', '모', '모바', '모바일', 'printf 모바일-IME-확인'];
  const heights = [720, 640, 760, 700, 680];
  for (const [index, value] of updates.entries()) {
    await terminalInput.evaluate((input, compositionValue) => {
      const textarea = input as HTMLTextAreaElement;
      textarea.value = compositionValue;
      textarea.dispatchEvent(
        new CompositionEvent('compositionupdate', {
          bubbles: true,
          data: compositionValue,
        })
      );
    }, value);
    await expect(composition).toHaveText(value);
    const height = heights[index];
    if (height === undefined) throw new Error('Missing mobile viewport test height.');
    await page.setViewportSize({ width: 412, height });
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(250);

  expect(sentTerminalMessages.map(websocketMessageType)).not.toContain('resize');
  await expect(terminalInput).toBeFocused();
  await expect(composition).toHaveClass(/active/);
  await expect(composition).toHaveText('printf 모바일-IME-확인');
  await expect(terminal).toHaveClass(/screen-ready/);
  await expect
    .poll(() =>
      terminal.evaluate((element) => {
        const screen = element.querySelector<HTMLElement>('.xterm-screen');
        const bounds = screen?.getBoundingClientRect();
        return Boolean(bounds && bounds.width > 0 && bounds.height > 0);
      })
    )
    .toBe(true);

  await terminalInput.evaluate((input, value) => {
    (input as HTMLTextAreaElement).dispatchEvent(
      new CompositionEvent('compositionend', { bubbles: true, data: value })
    );
  }, 'printf 모바일-IME-확인');
  await page.waitForTimeout(50);
  await expect(composition).not.toHaveClass(/active/);
  await terminalInput.press('Enter');
  await expect(page.locator('.xterm-rows')).toContainText('모바일-IME-확인');
  await page.waitForTimeout(250);
  expect(sentTerminalMessages.map(websocketMessageType)).not.toContain('resize');
  await expect(terminalInput).toBeFocused();
});

test('keeps server terminal geometry stable while the mobile composer fits the visible viewport', async ({
  context,
  page,
}) => {
  test.setTimeout(60_000);
  const sentTerminalMessages: Array<string | Buffer> = [];
  page.on('websocket', (socket) => {
    if (!new URL(socket.url()).pathname.endsWith('/ws/terminal')) return;
    socket.on('framesent', ({ payload }) => sentTerminalMessages.push(payload));
  });
  await authenticate(context);
  const workspace = await createWorkspace(context);
  workspaceId = workspace.id;

  await page.goto(`/workspaces/${encodeURIComponent(workspace.id)}`);
  await expectTerminalReady(page);
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  const composer = page.getByRole('textbox', { name: 'Terminal input' });
  await composer.focus();
  await expect(composer).toBeFocused();
  await page.waitForTimeout(250);
  sentTerminalMessages.length = 0;

  for (const height of [viewport!.height - 280, viewport!.height, viewport!.height - 320, viewport!.height]) {
    await page.setViewportSize({ width: viewport!.width, height });
    await page.waitForTimeout(250);
    await expect(composer).toBeFocused();
    const terminalFits = await page.locator('.terminal-frame').evaluate((frame) => {
      const frameBounds = frame.getBoundingClientRect();
      const screenBounds = frame.querySelector('.xterm-screen')?.getBoundingClientRect();
      return Boolean(screenBounds && screenBounds.bottom <= frameBounds.bottom + 1);
    });
    expect(terminalFits).toBe(true);
  }

  expect(sentTerminalMessages.map(websocketMessageType)).not.toContain('resize');
});

test('defers a reconnect snapshot until terminal IME composition finishes', async ({ context, page }) => {
  test.setTimeout(60_000);
  await authenticate(context);
  const workspace = await createWorkspace(context);
  workspaceId = workspace.id;

  let firstConnection: WebSocketRoute | undefined;
  let resolveFirstConnection!: () => void;
  let resolveSecondSnapshot!: () => void;
  const firstConnectionOpened = new Promise<void>((resolve) => {
    resolveFirstConnection = resolve;
  });
  const secondSnapshotReceived = new Promise<void>((resolve) => {
    resolveSecondSnapshot = resolve;
  });
  let connectionCount = 0;
  await page.routeWebSocket(/\/ws\/terminal(?:\?|$)/, (socket) => {
    const server = socket.connectToServer();
    connectionCount += 1;
    if (connectionCount === 1) {
      firstConnection = socket;
      resolveFirstConnection();
      return;
    }
    if (connectionCount !== 2) return;
    server.onMessage((message) => {
      if (websocketMessageType(message) === 'snapshot') resolveSecondSnapshot();
      socket.send(message);
    });
  });

  await page.goto(`/workspaces/${encodeURIComponent(workspace.id)}`);
  await firstConnectionOpened;
  await expectTerminalReady(page);
  const terminal = page.getByRole('application', { name: 'Interactive shell terminal' });
  await terminal.tap({ position: { x: 96, y: 96 } });
  const terminalInput = terminal.locator('.xterm-helper-textarea');
  const composition = terminal.locator('.composition-view');
  await expect(terminalInput).toBeFocused();

  await terminalInput.evaluate((input, value) => {
    const textarea = input as HTMLTextAreaElement;
    textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    textarea.value = value;
    textarea.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: value }));
  }, 'printf 재연결-IME-확인');
  await expect(composition).toHaveClass(/active/);
  await expect(composition).toHaveText('printf 재연결-IME-확인');

  await firstConnection!.close({ code: 1012, reason: 'mobile IME reconnect test' });
  await secondSnapshotReceived;
  await page.waitForTimeout(100);
  await expect(terminalInput).toBeFocused();
  await expect(composition).toHaveClass(/active/);
  await expect(composition).toHaveText('printf 재연결-IME-확인');

  await terminalInput.evaluate((input, value) => {
    (input as HTMLTextAreaElement).dispatchEvent(
      new CompositionEvent('compositionend', { bubbles: true, data: value })
    );
  }, 'printf 재연결-IME-확인');
  await page.waitForTimeout(50);
  await terminalInput.press('Enter');
  await expectTerminalReady(page);
  await expect(page.locator('.xterm-rows')).toContainText('재연결-IME-확인');
  await expect(terminalInput).toBeFocused();
  expect(connectionCount).toBe(2);
});

test('keeps the core workspace flow usable in a narrow viewport', async ({ context, page }) => {
  test.setTimeout(60_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await authenticate(context);
  const workspace = await createWorkspace(context);
  workspaceId = workspace.id;

  await page.goto(`/workspaces/${encodeURIComponent(workspace.id)}`);
  await expectTerminalReady(page);
  const statusBar = page.getByRole('region', { name: 'Server status plugins' });
  await expect(statusBar).toBeVisible();
  await expect(statusBar.locator('.status-plugin').filter({ hasText: 'CPU' })).toContainText('≈');
  await expect(statusBar.locator('.status-plugin').filter({ hasText: 'RAM' })).toContainText('%');
  await expect(page.getByRole('button', { name: 'Manage status widgets' })).toBeVisible();
  await expect(statusBar.getByRole('button', { name: 'Inspect listening ports' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Open workspaces' }).click();
  const workspaceList = page.getByRole('region', { name: 'Workspace list' });
  await expect(workspaceList.getByRole('button', { name: 'Inspect listening ports' })).toBeVisible();
  await expect(workspaceList.getByRole('button', { name: /Switch to .* theme/ })).toBeVisible();
  await expect(workspaceList.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await page.getByRole('button', { name: 'Close workspace navigator' }).click();
  const terminalTypography = await page
    .getByRole('application', { name: 'Interactive shell terminal' })
    .evaluate((terminal) => {
      const rows = terminal.querySelector<HTMLElement>('.xterm-rows');
      return {
        language: terminal.getAttribute('lang'),
        fontFamily: rows ? getComputedStyle(rows).fontFamily : '',
      };
    });
  expect(terminalTypography.language).toBe(await page.evaluate(() => navigator.language || 'und'));
  expect(terminalTypography.fontFamily).toContain('system-ui');
  expect(terminalTypography.fontFamily).toContain('sans-serif');
  expect(terminalTypography.fontFamily).not.toMatch(/(?:^|,)\s*(?:ui-)?monospace\s*(?:,|$)/);
  await run('tmux', [
    'send-keys',
    '-t',
    workspace.tmuxSession,
    '-l',
    '--',
    "printf '한글 日本語 简体中文 Русский Ελληνικά العربية עברית हिन्दी ไทย 😀\\n'",
  ]);
  await run('tmux', ['send-keys', '-t', workspace.tmuxSession, 'Enter']);
  await expect(page.locator('.xterm-rows')).toContainText(
    '한글 日本語 简体中文 Русский Ελληνικά العربية עברית हिन्दी ไทย 😀'
  );
  await expect(page.getByRole('textbox', { name: 'Terminal input' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Scroll to terminal top' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Scroll to terminal bottom' })).toBeVisible();

  await run('tmux', ['send-keys', '-t', workspace.tmuxSession, '-l', '--', 'seq 1 200']);
  await run('tmux', ['send-keys', '-t', workspace.tmuxSession, 'Enter']);
  const terminalRows = page.locator('.xterm-rows');
  const hasVisibleOutputLine = (value: string) =>
    terminalRows.evaluate(
      (rows, expected) => Array.from(rows.children).some((row) => row.textContent?.trim() === expected),
      value
    );
  await expect.poll(() => hasVisibleOutputLine('200')).toBe(true);
  await page.getByRole('button', { name: 'Scroll to terminal top' }).click();
  await expect.poll(() => hasVisibleOutputLine('1')).toBe(true);
  await page.getByRole('button', { name: 'Scroll to terminal bottom' }).click();
  await expect.poll(() => hasVisibleOutputLine('200')).toBe(true);

  const openBackground = page.getByRole('button', { name: 'Open background processes' });
  await expect(openBackground).toBeVisible();
  await openBackground.click();
  const backgroundSheet = page.getByRole('dialog');
  const backgroundTitle = backgroundSheet.getByRole('heading', { name: 'Background processes' });
  await expect(backgroundSheet).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Background command' })).toHaveCount(0);
  await expect(backgroundSheet.getByRole('button', { name: 'Run background command' })).toBeVisible();
  await backgroundSheet.getByRole('button', { name: 'Run background command' }).click();
  const backgroundCommand = page.getByRole('textbox', { name: 'Background command' });
  await expect(backgroundCommand).toBeFocused();
  await page.setViewportSize({ width: 412, height: 640 });
  await expect(backgroundCommand).toBeFocused();
  const backgroundCommandValue = 'seq 1 300; sleep 30';
  await backgroundCommand.fill(backgroundCommandValue);
  await backgroundSheet.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(backgroundCommand).toHaveCount(0);
  const output = backgroundSheet.getByRole('region', { name: `Output for ${backgroundCommandValue}` }).locator('pre');
  await expect(output).toContainText('300');
  await expect(backgroundSheet.getByRole('heading', { name: backgroundCommandValue })).toBeVisible();
  const stopBackground = page.getByRole('button', { name: `Stop ${backgroundCommandValue}` });
  await expect(stopBackground).toBeVisible();
  const sheetLayout = await backgroundSheet.evaluate((sheet) => {
    const bounds = sheet.getBoundingClientRect();
    const viewport = window.visualViewport;
    const top = viewport?.offsetTop ?? 0;
    const bottom = top + (viewport?.height ?? window.innerHeight);
    return {
      fitsViewport: bounds.top >= top - 1 && bounds.bottom <= bottom + 1,
      anchoredToBottom: Math.abs(bounds.bottom - bottom) <= 1,
    };
  });
  const outputScrolls = await output.evaluate((terminalOutput) => {
    terminalOutput.scrollTop = terminalOutput.scrollHeight;
    return terminalOutput.scrollHeight > terminalOutput.clientHeight && terminalOutput.scrollTop > 0;
  });
  expect(sheetLayout.fitsViewport).toBe(true);
  expect(sheetLayout.anchoredToBottom).toBe(true);
  expect(outputScrolls).toBe(true);
  await stopBackground.click();
  await expect(stopBackground).toBeHidden();
  await backgroundSheet.getByRole('button', { name: 'Close background manager' }).click();
  await expect(backgroundSheet).toBeHidden();
  await expect(openBackground).toBeFocused();
  await page.setViewportSize({ width: 412, height: 915 });

  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.getByRole('button', { name: 'Open workspaces' }).click();
  await expect(page.getByRole('region', { name: 'Workspace list' })).toBeVisible();
  await run('tmux', ['send-keys', '-t', workspace.tmuxSession, '-l', '--', "printf 'unobserved-mobile-output\\n'"]);
  await run('tmux', ['send-keys', '-t', workspace.tmuxSession, 'Enter']);
  await page.getByRole('button', { name: /Open running workspace workspace/ }).click();
  await expectTerminalReady(page);
  await expect.poll(() => pageErrors.filter((message) => message.includes('effect_update_depth_exceeded'))).toEqual([]);

  await page.getByRole('button', { name: 'Open repository' }).click();
  const repositoryPanel = page.getByRole('complementary', { name: 'Repository for workspace' });
  await expect(repositoryPanel).toBeVisible();
  await expect(repositoryPanel).toHaveCSS('transition-property', 'transform');
  await expect(repositoryPanel).toHaveCSS('transition-duration', '0.18s');
  await expect(repositoryPanel.getByRole('tab', { name: 'Git' })).toBeVisible();
  await repositoryPanel.getByRole('button', { name: 'Close workspace panel' }).click();
  await expect(repositoryPanel).toBeHidden();
  await page.getByRole('button', { name: 'Open repository' }).click();
  await expect(repositoryPanel).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Add inside workspace root' }).click();
  await expect(page.getByRole('menuitem', { name: 'Upload files…' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Upload folder…' })).toBeVisible();
  await page.keyboard.press('Escape');
  const conflictActions = page.getByRole('button', { name: 'Actions for file conflict.txt' });
  await expect(conflictActions).toBeVisible();
  await conflictActions.click();
  await expect(page.getByRole('menuitem', { name: 'Insert path into terminal' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Delete' })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Insert path into terminal' }).click();
  await expect(repositoryPanel).toBeHidden();
  await expect(page.locator('.xterm-rows')).toContainText('conflict.txt');
  await page.getByRole('button', { name: 'Open repository' }).click();
  await page.getByRole('button', { name: 'Open conflict.txt' }).click();
  await expect(page.locator('[aria-label="Edit conflict.txt"] .cm-content')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Close file and return to terminal' }).click();
  await expect(page.getByRole('textbox', { name: 'Terminal input' })).toBeVisible();

  await page.getByRole('button', { name: 'Add workspace note' }).click();
  const notePanel = page.locator('.workspace-note-panel');
  await expect(notePanel.getByRole('region', { name: 'Workspace note' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Workspace note' })).toHaveCount(0);
  await notePanel.getByRole('button', { name: 'Close workspace note' }).click();
  await expect(notePanel).toHaveAttribute('aria-hidden', 'true');
  await expect(notePanel).toHaveAttribute('inert', '');
});

test('keeps automation and widget management routable in a narrow viewport', async ({ context, page }) => {
  await authenticate(context);
  const workspace = await createWorkspace(context);
  workspaceId = workspace.id;

  await page.goto(`/workspaces/${encodeURIComponent(workspace.id)}/automations`);
  const automationPage = page.locator('section[aria-labelledby="workspace-automations-title"]');
  await expect(automationPage).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Agent automations' })).toHaveCount(0);
  await expect(automationPage.getByRole('heading', { name: 'Agent automations' })).toBeFocused();
  await expect(automationPage.getByLabel('Name')).toHaveCount(0);
  await page.reload();
  await expect(automationPage).toBeVisible();
  await expect(automationPage.getByRole('heading', { name: 'Agent automations' })).toBeFocused();
  await automationPage.getByRole('button', { name: 'New automation' }).click();
  await expect(automationPage.getByLabel('Name')).toBeFocused();
  const automationPrompt = automationPage.getByLabel('Prompt');
  await automationPrompt.focus();
  await page.setViewportSize({ width: 412, height: 500 });
  await expect(automationPrompt).toBeFocused();
  const managementScrolls = await automationPage.evaluate((surface) => {
    const element = surface as HTMLElement;
    element.scrollTop = element.scrollHeight;
    return element.scrollHeight > element.clientHeight && element.scrollTop > 0;
  });
  expect(managementScrolls).toBe(true);
  await expect(automationPage.getByRole('button', { name: 'Add automation' })).toBeInViewport();
  await page.setViewportSize({ width: 412, height: 915 });
  await automationPage.getByRole('button', { name: 'Back to automations' }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await automationPage.getByRole('button', { name: 'Close agent automations' }).click();
  await expect(page).toHaveURL(new RegExp(`/workspaces/${encodeURIComponent(workspace.id)}$`));
  await expectTerminalReady(page);

  await page.getByRole('button', { name: 'Open workspaces' }).click();
  await page.getByRole('button', { name: /Workspace actions for/ }).click();
  await page.getByRole('menuitem', { name: 'Agent automations' }).click();
  await expect(automationPage).toBeVisible();
  await expect(page.locator('.workspace-column')).not.toHaveClass(/mobile-open/);
  await automationPage.getByRole('button', { name: 'Close agent automations' }).click();
  await expectTerminalReady(page);
  await expect(page.getByRole('button', { name: 'Open workspaces' })).toBeFocused();

  await page.getByRole('button', { name: 'Manage status widgets' }).click();
  const statusPage = page.locator('section[aria-labelledby="status-widget-settings-title"]');
  await expect(statusPage).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Status widgets' })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const fitsViewport = await statusPage.evaluate((surface) => {
    const bounds = surface.getBoundingClientRect();
    return (
      bounds.left >= -1 &&
      bounds.right <= window.innerWidth + 1 &&
      bounds.top >= -1 &&
      bounds.bottom <= window.innerHeight + 1
    );
  });
  expect(fitsViewport).toBe(true);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/workspaces/${encodeURIComponent(workspace.id)}$`));
  await expectTerminalReady(page);
});

test('anchors a status popover to the mobile status bar and dismisses it for workspace tools', async ({
  context,
  page,
}) => {
  await authenticate(context);
  const workspace = await createWorkspace(context);
  workspaceId = workspace.id;

  await page.goto(`/workspaces/${encodeURIComponent(workspace.id)}`);
  await expectTerminalReady(page);
  const statusBar = page.getByRole('region', { name: 'Server status plugins' });
  const cpuPlugin = statusBar.locator('.status-plugin').filter({ hasText: 'CPU' });
  await expect(cpuPlugin).toBeVisible();
  await page.getByRole('button', { name: 'Open workspaces' }).click();
  const workspaceList = page.getByRole('region', { name: 'Workspace list' });
  const ports = workspaceList.getByRole('button', { name: 'Inspect listening ports' });
  const theme = workspaceList.getByRole('button', { name: /Switch to .* theme/ });
  const [portsBox, portsIconBox, themeBox] = await Promise.all([
    ports.boundingBox(),
    ports.locator('svg').boundingBox(),
    theme.boundingBox(),
  ]);
  expect(portsBox).not.toBeNull();
  expect(portsIconBox).not.toBeNull();
  expect(themeBox).not.toBeNull();
  expect(Math.abs(portsBox!.width - themeBox!.width)).toBeLessThan(1);
  expect(portsIconBox!.x).toBeGreaterThan(portsBox!.x);
  await page.getByRole('button', { name: 'Close workspace navigator' }).click();
  await cpuPlugin.click();
  const popover = page.locator('.status-plugin-popover');
  const repositoryButton = page.getByRole('button', { name: 'Open repository' });
  await expect(popover).toBeVisible();
  const [popoverBox, statusBarBox, viewportWidth] = await Promise.all([
    popover.boundingBox(),
    statusBar.boundingBox(),
    page.evaluate(() => window.innerWidth),
  ]);
  expect(popoverBox).not.toBeNull();
  expect(statusBarBox).not.toBeNull();
  expect(popoverBox!.width).toBeLessThanOrEqual(14 * 16);
  expect(popoverBox!.x).toBeGreaterThanOrEqual(7);
  expect(popoverBox!.x + popoverBox!.width).toBeLessThanOrEqual(viewportWidth + 1);
  const statusBarBottom = statusBarBox!.y + statusBarBox!.height;
  expect(popoverBox!.y).toBeGreaterThanOrEqual(statusBarBottom);
  expect(popoverBox!.y - statusBarBottom).toBeLessThan(16);

  await repositoryButton.click();
  await expect(page.getByRole('complementary', { name: 'Repository for workspace' })).toBeVisible();
  await expect(popover).toBeHidden();
});
