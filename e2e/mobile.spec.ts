import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, test, type WebSocketRoute } from '@playwright/test';
import { E2E_TMUX_SOCKET_NAME } from './runtime.ts';
import {
  authenticate,
  createWorkspace,
  expectTerminalReady,
  removeWorkspace,
  resetWorkspaces,
  resetStatusPlugins,
  resetTerminalInputSettings,
} from './support.ts';

let workspaceId: string | undefined;
const run = promisify(execFile);
const runTmux = (arguments_: readonly string[]) => run('tmux', ['-L', E2E_TMUX_SOCKET_NAME, ...arguments_]);

function websocketMessageType(message: string | Buffer): string | undefined {
  try {
    const value = JSON.parse(message.toString()) as { type?: unknown };
    return typeof value.type === 'string' ? value.type : undefined;
  } catch {
    return undefined;
  }
}

function websocketInputData(message: string | Buffer): string | undefined {
  try {
    const value = JSON.parse(message.toString()) as { type?: unknown; data?: unknown };
    if (value.type !== 'input' || typeof value.data !== 'string') return undefined;
    // Firefox's Playwright transport can surface websocket text bytes as a
    // Latin-1 string. Re-decode only when the bytes form valid UTF-8 so real
    // Latin-1 input is not silently changed.
    if (!/[\u0080-\u00ff]/u.test(value.data)) return value.data;
    try {
      const decoded = Buffer.from(value.data, 'latin1').toString('utf8');
      return decoded.includes('\uFFFD') ? value.data : decoded;
    } catch {
      return value.data;
    }
  } catch {
    return undefined;
  }
}

test.beforeEach(async ({ request }) => {
  workspaceId = undefined;
  await Promise.all([resetWorkspaces(request), resetStatusPlugins(request), resetTerminalInputSettings(request)]);
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
  await expect(terminalFrame).toBeVisible();
  await expect(page.getByPlaceholder('Compose a message…')).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('keeps direct terminal input and the composer independently available on mobile', async ({ context, page }) => {
  await authenticate(context);
  const workspace = await createWorkspace(context);
  workspaceId = workspace.id;

  await page.goto(`/workspaces/${encodeURIComponent(workspace.id)}`);
  await expectTerminalReady(page);
  const terminal = page.getByRole('application', { name: 'Interactive shell terminal' });
  const composer = page.getByPlaceholder('Compose a message…');
  const hiddenTerminalInput = terminal.locator('.xterm-helper-textarea');
  await expect(page.getByRole('group', { name: 'Terminal input method' })).toHaveCount(0);
  await expect(hiddenTerminalInput).not.toHaveAttribute('readonly', '');

  await terminal.tap({ position: { x: 96, y: 96 } });
  await expect(hiddenTerminalInput).not.toHaveAttribute('readonly', '');
  await expect(hiddenTerminalInput).toBeFocused();
  await hiddenTerminalInput.pressSequentially("printf 'DIRECT-TERMINAL-TAP\\n'");
  await hiddenTerminalInput.press('Enter');
  await expect(page.locator('.xterm-rows')).toContainText('DIRECT-TERMINAL-TAP');

  await composer.focus();
  await expect(composer).toBeFocused();
  await expect(hiddenTerminalInput).not.toBeFocused();
  await composer.fill('first line');
  await composer.press('Shift+Enter');
  await expect(composer).toHaveValue('first line\n');
  await composer.fill('');

  const updates = ['ㅎ', '하', '한', '한그', '한글'];
  await composer.evaluate((input) => {
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
  });
  await composer.evaluate((input) => {
    const textarea = input as HTMLTextAreaElement;
    textarea.value = 'composition pending';
    textarea.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        data: 'composition pending',
        inputType: 'insertCompositionText',
        isComposing: true,
      })
    );
  });
  await composer.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
  await composer.evaluate((input) => {
    const event = new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' });
    Object.defineProperty(event, 'keyCode', { value: 229 });
    input.dispatchEvent(event);
  });
  await expect(composer).toHaveValue('composition pending');
  for (const value of updates) {
    await composer.evaluate((input, compositionValue) => {
      const textarea = input as HTMLTextAreaElement;
      textarea.value = compositionValue;
      textarea.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          data: compositionValue,
          inputType: 'insertCompositionText',
          isComposing: true,
        })
      );
      textarea.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: compositionValue }));
    }, value);
    await expect(composer).toHaveValue(value);
  }
  await composer.evaluate((input, value) => {
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: value }));
  }, updates.at(-1));
  await expect(composer).toHaveValue('한글');

  await terminal.tap({ position: { x: 96, y: 96 } });
  await expect(hiddenTerminalInput).not.toHaveAttribute('readonly', '');
  await expect(composer).not.toBeFocused();
  await expect(hiddenTerminalInput).toBeFocused();
  await composer.focus();
  await expect(hiddenTerminalInput).not.toBeFocused();
  await expect(composer).toBeFocused();
});

test('does not drop back-to-back Korean terminal compositions before Space', async ({ context, page }) => {
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
  const hiddenTerminalInput = terminal.locator('.xterm-helper-textarea');
  await terminal.tap({ position: { x: 96, y: 96 } });
  await expect(hiddenTerminalInput).not.toHaveAttribute('readonly', '');
  await expect(hiddenTerminalInput).toBeFocused();
  sentTerminalMessages.length = 0;

  await hiddenTerminalInput.evaluate(async (element) => {
    const textarea = element as HTMLTextAreaElement;
    const prefix = textarea.value;
    let composed = '';
    for (const syllable of ['우', '리', '가']) {
      textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
      textarea.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: syllable }));
      composed += syllable;
      textarea.value = `${prefix}${composed}`;
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: syllable }));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    const space = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: ' ',
      code: 'Space',
    });
    Object.defineProperty(space, 'keyCode', { value: 32 });
    Object.defineProperty(space, 'which', { value: 32 });
    textarea.dispatchEvent(space);
  });

  await expect
    .poll(() =>
      sentTerminalMessages
        .map(websocketInputData)
        .filter((data) => data !== undefined)
        .join('')
    )
    .toBe('우리가');
});


test('keeps a Compose draft focused while scrolling and switches on a deliberate terminal tap', async ({
  context,
  page,
}) => {
  await authenticate(context);
  const workspace = await createWorkspace(context);
  workspaceId = workspace.id;

  await page.goto(`/workspaces/${encodeURIComponent(workspace.id)}`);
  await expectTerminalReady(page);
  const terminal = page.getByRole('application', { name: 'Interactive shell terminal' });
  const composer = page.getByPlaceholder('Compose a message…');
  await composer.fill('Keep this unfinished prompt');
  await expect(composer).toBeFocused();

  await terminal.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const startY = bounds.top + Math.min(120, bounds.height * 0.35);
    const pointer = (type: string, clientY: number) =>
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: bounds.left + bounds.width / 2,
        clientY,
        isPrimary: true,
        pointerId: 42,
        pointerType: 'touch',
      });
    element.dispatchEvent(pointer('pointerdown', startY));
    element.dispatchEvent(pointer('pointermove', startY + 80));
    element.dispatchEvent(pointer('pointerup', startY + 80));
  });
  await expect(composer).toBeFocused();

  await terminal.tap({ position: { x: 96, y: 96 } });
  await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
  await composer.tap();
  await expect(composer).toBeFocused();
});

test('keeps mobile composition visible while terminal output and viewport geometry change', async ({
  context,
  page,
}) => {
  test.setTimeout(60_000);
  await authenticate(context);
  const workspace = await createWorkspace(context);
  workspaceId = workspace.id;

  await page.goto(`/workspaces/${encodeURIComponent(workspace.id)}`);
  await expectTerminalReady(page);
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  const composer = page.getByPlaceholder('Compose a message…');
  await composer.focus();
  await composer.evaluate((input) => {
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
  });
  await runTmux(['send-keys', '-t', workspace.tmuxSession, '-l', '--', "printf '\\nOUTPUT-DURING-MOBILE-IME\\n'"]);
  await runTmux(['send-keys', '-t', workspace.tmuxSession, 'Enter']);
  await expect(page.locator('.xterm-rows')).toContainText('OUTPUT-DURING-MOBILE-IME');

  const updates = ['ㅁ', '모', '모바', '모바일', 'printf 모바일-IME-확인'];
  const heights = [120, 200, 100, 160, 180].map((reduction) => Math.max(280, viewport!.height - reduction));
  for (const [index, value] of updates.entries()) {
    await composer.evaluate((input, compositionValue) => {
      const textarea = input as HTMLTextAreaElement;
      textarea.value = compositionValue;
      textarea.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          data: compositionValue,
          inputType: 'insertCompositionText',
          isComposing: true,
        })
      );
      textarea.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: compositionValue }));
    }, value);
    await expect(composer).toHaveValue(value);
    const height = heights[index];
    if (height === undefined) throw new Error('Missing mobile viewport test height.');
    await page.setViewportSize({ width: viewport!.width, height });
    await page.waitForTimeout(60);
  }
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue('printf 모바일-IME-확인');

  await composer.evaluate((input, value) => {
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: value }));
  }, 'printf 모바일-IME-확인');
  await composer.press('Enter');
  await expect(page.locator('.xterm-rows')).toContainText('모바일-IME-확인');
  await expect(composer).toBeFocused();
});


test('keeps a usable terminal and composer in an extreme keyboard-height viewport', async ({ context, page }) => {
  await authenticate(context);
  const workspace = await createWorkspace(context);
  workspaceId = workspace.id;

  await page.goto(`/workspaces/${encodeURIComponent(workspace.id)}`);
  await expectTerminalReady(page);
  await page.setViewportSize({ width: 320, height: 280 });
  await expect(page.getByRole('button', { name: 'Switch between Compose and Terminal' })).toBeVisible();
  const composer = page.getByPlaceholder('Compose a message…');
  await expect(composer).toBeVisible();
  await composer.fill('extreme viewport input');
  await expect(composer).toHaveValue('extreme viewport input');
  await expect(page.getByRole('application', { name: 'Interactive shell terminal' })).toBeVisible();
  await expect(page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('keeps a wide single-line composer and opens secondary actions on a narrow screen', async ({ context, page }) => {
  await authenticate(context);
  const workspace = await createWorkspace(context);
  workspaceId = workspace.id;
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto(`/workspaces/${encodeURIComponent(workspace.id)}`);
  await expectTerminalReady(page);
  const composer = page.getByPlaceholder('Compose a message…');
  await expect.poll(() => composer.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(150);
  await expect
    .poll(() => page.locator('.composer').evaluate((element) => element.getBoundingClientRect().height))
    .toBeLessThanOrEqual(52);
  const actions = page.getByRole('button', { name: 'More message actions' });
  await actions.click();
  await expect(page.getByRole('button', { name: 'Bypass template for this message' })).toHaveCount(0);
  await expect(page.locator('.composer-action-list button')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Preview final message' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Expand composer' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Open Composer history' }).click();
  await expect(page.getByRole('region', { name: 'Composer history' })).toBeVisible();
  await page.getByRole('combobox', { name: 'Search sent prompts' }).press('Escape');
  await expect(composer).toBeFocused();
  await composer.fill('Review this change');
  await actions.click();
  await expect(page.locator('.composer-action-list button')).toHaveCount(2);
  await composer.tap();
  await expect(page.locator('.composer-action-list')).toBeHidden();
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue('Review this change');
  await actions.click();
  const fileChooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Send an image to the shell' }).click();
  expect((await fileChooser).isMultiple()).toBe(false);
  await actions.click();
  await expect(page.locator('.composer-action-list')).toBeVisible();
  await page.setViewportSize({ width: 900, height: 640 });
  await expect(actions).toBeHidden();
  await expect(page.locator('.composer-action-list')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Open Composer history' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send an image to the shell' })).toBeVisible();
  await page.setViewportSize({ width: 320, height: 640 });
  await expect(actions).toBeVisible();
  await composer.fill('');
});

test('preserves mobile composition through a reconnect snapshot', async ({ context, page }) => {
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
  const composer = page.getByPlaceholder('Compose a message…');
  await composer.focus();

  await composer.evaluate((input, value) => {
    const textarea = input as HTMLTextAreaElement;
    textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    textarea.value = value;
    textarea.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        data: value,
        inputType: 'insertCompositionText',
        isComposing: true,
      })
    );
    textarea.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: value }));
  }, 'printf 재연결-IME-확인');
  await expect(composer).toHaveValue('printf 재연결-IME-확인');

  await firstConnection!.close({ code: 1012, reason: 'mobile IME reconnect test' });
  await secondSnapshotReceived;
  await expectTerminalReady(page);
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue('printf 재연결-IME-확인');

  await composer.evaluate((input, value) => {
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: value }));
  }, 'printf 재연결-IME-확인');
  await composer.press('Enter');
  await expect(page.locator('.xterm-rows')).toContainText('재연결-IME-확인');
  await expect(composer).toBeFocused();
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
  await expect(page.getByRole('button', { name: 'Open settings' })).toBeVisible();
  await page.getByRole('button', { name: 'Open settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(page.getByRole('radio', { name: /System/ })).toBeVisible();
  await page.getByRole('navigation', { name: 'App settings sections' }).getByRole('button', { name: 'Terminal', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Keyboard shortcuts' })).toBeVisible();
  await expect(page.getByText('Switch input', { exact: true })).toBeVisible();
  await page.getByRole('navigation', { name: 'App settings sections' }).getByRole('button', { name: 'General', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await page.getByRole('button', { name: 'Close settings' }).click();
  await expectTerminalReady(page);
  await runTmux([
    'send-keys',
    '-t',
    workspace.tmuxSession,
    '-l',
    '--',
    "printf '한글 日本語 简体中文 Русский Ελληνικά العربية עברית हिन्दी ไทย 😀\\n'",
  ]);
  await runTmux(['send-keys', '-t', workspace.tmuxSession, 'Enter']);
  await expect(page.locator('.xterm-rows')).toContainText(
    '한글 日本語 简体中文 Русский Ελληνικά العربية עברית हिन्दी ไทย 😀'
  );
  await expect(page.getByPlaceholder('Compose a message…')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Scroll to terminal top' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Scroll terminal up one page' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Scroll terminal down one page' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Scroll to terminal bottom' })).toBeVisible();
  const historyControlLabels = await page
    .getByRole('group', { name: 'Terminal controls' })
    .getByRole('button')
    .evaluateAll((buttons) =>
      buttons
        .map((button) => button.textContent?.trim() ?? '')
        .filter((label) => ['Top', 'PgUp', 'PgDn', 'Bottom'].includes(label))
    );
  expect(historyControlLabels).toEqual(['Top', 'PgUp', 'PgDn', 'Bottom']);

  await runTmux(['send-keys', '-t', workspace.tmuxSession, '-l', '--', 'seq 1 200']);
  await runTmux(['send-keys', '-t', workspace.tmuxSession, 'Enter']);
  const terminalRows = page.locator('.xterm-rows');
  const hasVisibleOutputLine = (value: string) =>
    terminalRows.evaluate(
      (rows, expected) => Array.from(rows.children).some((row) => row.textContent?.trim() === expected),
      value
    );
  await expect.poll(() => hasVisibleOutputLine('200')).toBe(true);
  await page.getByRole('button', { name: 'Scroll terminal up one page' }).click();
  await expect.poll(() => hasVisibleOutputLine('200')).toBe(false);
  await page.getByRole('button', { name: 'Scroll terminal down one page' }).click();
  await expect.poll(() => hasVisibleOutputLine('200')).toBe(true);
  await page.getByRole('button', { name: 'Scroll to terminal top' }).click();
  await expect.poll(() => hasVisibleOutputLine('1')).toBe(true);
  await page.getByRole('button', { name: 'Scroll to terminal bottom' }).click();
  await expect.poll(() => hasVisibleOutputLine('200')).toBe(true);

  const openBackground = page.getByRole('button', { name: 'Open background processes' });
  await expect(openBackground).toBeVisible();
  await openBackground.click();
  const backgroundSheet = page.locator('aside.background-panel');
  const backgroundTitle = backgroundSheet.locator('header').first().locator('strong');
  await expect(backgroundSheet).toBeVisible();
  await expect(backgroundTitle).toHaveText('Background');
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
  await expect(backgroundTitle).toHaveText('Output');
  await expect(backgroundSheet.getByText(backgroundCommandValue, { exact: true })).toBeVisible();
  const stopBackground = page.getByRole('button', { name: `Stop ${backgroundCommandValue}` });
  await expect(stopBackground).toBeVisible();
  await stopBackground.click();
  await expect(stopBackground).toBeHidden();
  await backgroundSheet.getByRole('button', { name: 'Close background manager' }).click();
  await expect(backgroundSheet).toHaveAttribute('aria-hidden', 'true');
  await expect(openBackground).toBeFocused();
  await page.setViewportSize({ width: 412, height: 915 });

  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.getByRole('button', { name: 'Open workspaces' }).click();
  await expect(page.getByRole('region', { name: 'Workspace list' })).toBeVisible();
  await runTmux(['send-keys', '-t', workspace.tmuxSession, '-l', '--', "printf 'unobserved-mobile-output\\n'"]);
  await runTmux(['send-keys', '-t', workspace.tmuxSession, 'Enter']);
  await page.getByRole('button', { name: /Open running workspace workspace/ }).click();
  await expectTerminalReady(page);
  await expect.poll(() => pageErrors.filter((message) => message.includes('effect_update_depth_exceeded'))).toEqual([]);

  await page.getByRole('button', { name: 'Open repository' }).click();
  const repositoryPanel = page.getByRole('complementary', { name: 'Repository for workspace' });
  await expect(repositoryPanel).toBeVisible();
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
  const fileEditor = page.getByLabel('File for conflict.txt');
  const editor = fileEditor.getByRole('textbox', { name: 'Editor for conflict.txt' });
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await editor.click();
  await expect(editor).toBeFocused();
  await page.getByRole('button', { name: 'Close file and return to terminal' }).click();
  await expect(page.getByPlaceholder('Compose a message…')).toBeVisible();

  await page.getByRole('button', { name: 'Add workspace note' }).click();
  const notePanel = page.locator('.workspace-note-panel');
  await expect(notePanel.getByRole('region', { name: 'Note', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Note', exact: true })).toHaveCount(0);
  await notePanel.getByRole('button', { name: 'Close workspace note' }).click();
  await expect(notePanel).toHaveAttribute('aria-hidden', 'true');
  await expect(notePanel).toHaveAttribute('inert', '');
});

test('keeps automation and widget management routable in a narrow viewport', async ({ context, page }) => {
  await authenticate(context);
  const workspace = await createWorkspace(context);
  workspaceId = workspace.id;

  await page.goto(`/workspaces/${encodeURIComponent(workspace.id)}/settings?section=automations`);
  const automationPage = page.locator('section[aria-labelledby="workspace-automations-section-title"]');
  await expect(automationPage).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Agent automations' })).toHaveCount(0);
  await expect(automationPage.getByLabel('Name')).toHaveCount(0);
  await page.reload();
  await expect(automationPage).toBeVisible();
  await automationPage.getByRole('button', { name: 'New automation' }).click();
  await expect(automationPage.getByLabel('Name')).toBeFocused();
  const automationPrompt = automationPage.getByLabel('Prompt');
  await automationPrompt.focus();
  await page.setViewportSize({ width: 412, height: 500 });
  await expect(automationPrompt).toBeFocused();
  await expect
    .poll(() =>
      page.locator('.management-body').evaluate((body) => {
        const element = body as HTMLElement;
        element.scrollTop = element.scrollHeight;
        return element.scrollHeight > element.clientHeight && element.scrollTop > 0;
      })
    )
    .toBe(true);
  await expect(automationPage.getByRole('button', { name: 'Add automation' })).toBeInViewport();
  await page.setViewportSize({ width: 412, height: 915 });
  await automationPage.getByRole('button', { name: 'Back to automations' }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Close workspace settings' }).click();
  await expect(page).toHaveURL(new RegExp(`/workspaces/${encodeURIComponent(workspace.id)}$`));
  await expectTerminalReady(page);

  await page.getByRole('button', { name: 'Open workspaces' }).click();
  await page.getByRole('button', { name: /Workspace actions for/ }).click();
  await page.getByRole('menuitem', { name: 'Workspace settings' }).click();
  await page.getByRole('navigation', { name: 'Workspace settings sections' }).getByRole('button', { name: 'Automations', exact: true }).click();
  const workspaceAutomationSettings = page.locator('section[aria-labelledby="workspace-automations-section-title"]');
  await expect(workspaceAutomationSettings).toBeVisible();
  await expect(page.locator('.workspace-column')).not.toHaveClass(/mobile-open/);
  await page.getByRole('button', { name: 'Close workspace settings' }).click();
  await expectTerminalReady(page);
  await expect(page.getByRole('button', { name: 'Open workspaces' })).toBeFocused();

  await page.getByRole('button', { name: 'Manage status widgets' }).click();
  await expect(page).toHaveURL(new RegExp(`/settings\\?workspace=${encodeURIComponent(workspace.id)}&section=widgets$`));
  const appSettings = page.locator('section[aria-labelledby="application-settings-title"]');
  const statusPage = appSettings
    .locator('.settings-section')
    .filter({ hasText: 'Configure the information shown above terminals.' });
  await expect(appSettings).toBeVisible();
  await expect(statusPage).toBeVisible();
  await expect(
    page
      .getByRole('navigation', { name: 'App settings sections' })
      .getByRole('button', { name: 'Status widgets', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
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
  const settingsButton = page.getByRole('button', { name: 'Open settings' });
  await expect(settingsButton).toBeVisible();
  await page.getByRole('button', { name: 'Close workspace navigator' }).click();
  await cpuPlugin.click();
  const popover = page.locator('.status-plugin-popover');
  const repositoryButton = page.getByRole('button', { name: 'Open repository' });
  await expect(popover).toBeVisible();
  await expect(popover).toContainText('CPU');

  await repositoryButton.click();
  await expect(page.getByRole('complementary', { name: 'Repository for workspace' })).toBeVisible();
  await expect(popover).toBeHidden();
});
