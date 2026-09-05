import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, test, type WebSocketRoute } from '@playwright/test';
import { E2E_TMUX_SOCKET_NAME } from './runtime.ts';
import {
  authenticate,
  createWorkspace,
  expectTerminalReady,
  observeTerminalFrames,
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
    // Latin-1 string. Only re-decode that unmistakable C1-control form.
    return /[\u0080-\u009f]/u.test(value.data) ? Buffer.from(value.data, 'latin1').toString('utf8') : value.data;
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
  const [frameBox, errorBox] = await Promise.all([terminalFrame.boundingBox(), connectionError.boundingBox()]);
  expect(frameBox).not.toBeNull();
  expect(errorBox).not.toBeNull();
  expect(errorBox!.y).toBeGreaterThanOrEqual(frameBox!.y);
  expect(errorBox!.y + errorBox!.height).toBeLessThanOrEqual(frameBox!.y + frameBox!.height + 1);
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

  await hiddenTerminalInput.evaluate((element) => {
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

test('keeps touch scrolling after the terminal takes direct input ownership', async ({ context, page }) => {
  await authenticate(context);
  const workspace = await createWorkspace(context);
  workspaceId = workspace.id;
  const fillCommand = 'i=1; while [ $i -le 120 ]; do printf \'TOUCH_SCROLL_%03d\\n\' "$i"; i=$((i+1)); done';
  await runTmux(['send-keys', '-t', workspace.tmuxSession, '-l', '--', fillCommand]);
  await runTmux(['send-keys', '-t', workspace.tmuxSession, 'Enter']);
  await expect
    .poll(async () => (await runTmux(['capture-pane', '-p', '-S', '-', '-t', workspace.tmuxSession])).stdout)
    .toContain('TOUCH_SCROLL_120');

  await page.goto(`/workspaces/${encodeURIComponent(workspace.id)}`);
  await expectTerminalReady(page);
  const terminal = page.getByRole('application', { name: 'Interactive shell terminal' });
  const hiddenTerminalInput = terminal.locator('.xterm-helper-textarea');
  const visibleRowNumbers = () =>
    terminal
      .locator('.xterm-screen > .xterm-rows > div')
      .allTextContents()
      .then((rows) =>
        rows
          .map((row) => /TOUCH_SCROLL_(\d+)/u.exec(row)?.[1])
          .filter((value): value is string => value !== undefined)
          .map(Number)
      );
  await terminal.tap({ position: { x: 96, y: 96 } });
  await expect(hiddenTerminalInput).toBeFocused();
  const bottomRows = await visibleRowNumbers();
  expect(bottomRows.length).toBeGreaterThan(0);
  const bottomMinimum = Math.min(...bottomRows);

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
        pointerId: 41,
        pointerType: 'touch',
      });
    element.dispatchEvent(pointer('pointerdown', startY));
    element.dispatchEvent(pointer('pointermove', startY + 80));
    element.dispatchEvent(pointer('pointerup', startY + 80));
  });

  await expect
    .poll(async () => {
      const rows = await visibleRowNumbers();
      return rows.length > 0 ? Math.min(...rows) : bottomMinimum;
    })
    .toBeLessThan(bottomMinimum);
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

  const alignment = await page.locator('.composer').evaluate((element) => {
    const textarea = element.querySelector('textarea')?.getBoundingClientRect();
    const sendButton = element.querySelector('.send-button')?.getBoundingClientRect();
    if (!textarea || !sendButton) return undefined;
    return {
      centerDelta: Math.abs(textarea.y + textarea.height / 2 - (sendButton.y + sendButton.height / 2)),
      heightDelta: Math.abs(textarea.height - sendButton.height),
    };
  });
  expect(alignment).toEqual({ centerDelta: 0, heightDelta: 0 });

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
  const terminal = page.getByRole('application', { name: 'Interactive shell terminal' });
  const composer = page.getByPlaceholder('Compose a message…');
  await composer.focus();
  await composer.evaluate((input) => {
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
  });
  sentTerminalMessages.length = 0;
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
  await expect(terminal).toHaveClass(/screen-ready/);

  await composer.evaluate((input, value) => {
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: value }));
  }, 'printf 모바일-IME-확인');
  await composer.press('Enter');
  await expect(page.locator('.xterm-rows')).toContainText('모바일-IME-확인');
  expect(sentTerminalMessages.map(websocketMessageType)).toContain('resize');
  await expect(composer).toBeFocused();
});

test('resizes terminal geometry to keep the mobile keyboard from hiding active content', async ({ context, page }) => {
  test.setTimeout(60_000);
  const sentTerminalMessages: Array<string | Buffer> = [];
  let delayServerMessages = false;
  page.on('websocket', (socket) => {
    if (!new URL(socket.url()).pathname.endsWith('/ws/terminal')) return;
    socket.on('framesent', ({ payload }) => sentTerminalMessages.push(payload));
  });
  await page.routeWebSocket(/\/ws\/terminal(?:\?|$)/, (socket) => {
    const server = socket.connectToServer();
    const delayedMessages: Array<string | Buffer> = [];
    let flushScheduled = false;
    server.onMessage((message) => {
      if (delayServerMessages) {
        delayedMessages.push(message);
        if (!flushScheduled) {
          flushScheduled = true;
          setTimeout(() => {
            flushScheduled = false;
            for (const delayed of delayedMessages.splice(0)) socket.send(delayed);
          }, 700);
        }
        return;
      }
      socket.send(message);
    });
  });
  await authenticate(context);
  const workspace = await createWorkspace(context);
  workspaceId = workspace.id;

  await page.goto(`/workspaces/${encodeURIComponent(workspace.id)}`);
  await expectTerminalReady(page);
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  const composer = page.getByPlaceholder('Compose a message…');
  await composer.focus();
  await expect(composer).toBeFocused();
  await page.waitForTimeout(250);
  sentTerminalMessages.length = 0;
  const initialScreenHeight = await page
    .locator('.xterm-screen')
    .evaluate((screen) => screen.getBoundingClientRect().height);

  // Android Firefox can leave VisualViewport at its previous height while
  // innerHeight is the only value that reflects the software keyboard.
  await page.evaluate(() => {
    const visualViewport = window.visualViewport;
    if (!visualViewport) return;
    const staleHeight = visualViewport.height;
    Object.defineProperty(visualViewport, 'height', {
      configurable: true,
      get: () => staleHeight,
    });
  });

  delayServerMessages = true;
  await page.setViewportSize({ width: viewport!.width, height: viewport!.height - 320 });
  await page.waitForTimeout(250);
  await expect(composer).toBeFocused();
  const pendingScreenHeight = await page
    .locator('.xterm-screen')
    .evaluate((screen) => screen.getBoundingClientRect().height);
  expect(pendingScreenHeight).toBeLessThan(initialScreenHeight);
  expect(sentTerminalMessages.map(websocketMessageType)).toContain('resize');

  await expect
    .poll(() =>
      page.locator('.terminal-frame').evaluate((frame) => {
        const frameBounds = frame.getBoundingClientRect();
        const terminalBounds = frame.querySelector<HTMLElement>(':scope > .terminal')?.getBoundingClientRect();
        const screenBounds = frame.querySelector<HTMLElement>('.xterm-screen')?.getBoundingClientRect();
        const cursorBounds = frame.querySelector<HTMLElement>('.xterm-helper-textarea')?.getBoundingClientRect();
        const composerBounds = document.querySelector('.composer')?.getBoundingClientRect();
        const visualViewport = window.visualViewport;
        const viewportBottom =
          (visualViewport?.offsetTop ?? 0) + Math.min(visualViewport?.height ?? window.innerHeight, window.innerHeight);
        return {
          composerFits: Boolean(composerBounds && composerBounds.bottom <= viewportBottom + 1),
          frameFitsScreen: Boolean(
            terminalBounds &&
              screenBounds &&
              Math.abs(terminalBounds.height - frameBounds.height) <= 1 &&
              screenBounds.bottom <= frameBounds.bottom + 1
          ),
          activeCursorVisible: Boolean(
            cursorBounds && cursorBounds.top >= frameBounds.top - 1 && cursorBounds.bottom <= frameBounds.bottom + 1
          ),
        };
      })
    )
    .toEqual({
      composerFits: true,
      frameFitsScreen: true,
      activeCursorVisible: true,
    });

  delayServerMessages = false;
  await page.setViewportSize({ width: viewport!.width, height: viewport!.height });
  await expect(composer).toBeFocused();
});

test('keeps a usable terminal and composer in an extreme keyboard-height viewport', async ({ context, page }) => {
  await authenticate(context);
  const workspace = await createWorkspace(context);
  workspaceId = workspace.id;

  await page.goto(`/workspaces/${encodeURIComponent(workspace.id)}`);
  await expectTerminalReady(page);
  await page.setViewportSize({ width: 320, height: 280 });

  const composer = page.getByPlaceholder('Compose a message…');
  await expect(composer).toBeVisible();
  await composer.fill('extreme viewport input');
  await expect(composer).toHaveValue('extreme viewport input');
  await expect
    .poll(() =>
      page.evaluate(() => {
        const frame = document.querySelector<HTMLElement>('.terminal-frame');
        const screen = document.querySelector<HTMLElement>('.xterm-screen');
        const rows = document.querySelector<HTMLElement>('.xterm-rows');
        const composerElement = document.querySelector<HTMLElement>('.composer');
        const viewport = window.visualViewport;
        if (!frame || !screen || !rows || !composerElement) return undefined;
        const frameBounds = frame.getBoundingClientRect();
        const screenBounds = screen.getBoundingClientRect();
        const composerBounds = composerElement.getBoundingClientRect();
        const viewportTop = viewport?.offsetTop ?? 0;
        const viewportBottom = viewportTop + (viewport?.height ?? innerHeight);
        return {
          composerFits: composerBounds.top >= viewportTop && composerBounds.bottom <= viewportBottom + 1,
          frameFits: screenBounds.bottom <= frameBounds.bottom + 1,
          usableRows: rows.childElementCount >= 5,
          scrollFits: document.documentElement.scrollWidth <= innerWidth,
        };
      })
    )
    .toEqual({ composerFits: true, frameFits: true, usableRows: true, scrollFits: true });
});

test('keeps numbered normal-screen rows unique through repeated mobile resizes', async ({ context, page }) => {
  await authenticate(context);
  const workspace = await createWorkspace(context);
  workspaceId = workspace.id;

  await page.goto(`/workspaces/${encodeURIComponent(workspace.id)}`);
  await expectTerminalReady(page);
  const composer = page.getByPlaceholder('Compose a message…');
  await composer.fill(`for i in $(seq 1 5); do printf 'VAMPIRE_UNIQUE_%04d\\n' "$i"; done`);
  await composer.press('Enter');
  const terminalRows = page.locator('.xterm-rows');
  await expect(terminalRows).toContainText('VAMPIRE_UNIQUE_0005');
  // The echoed command can wrap across rendered rows on a narrow screen.
  expect((await terminalRows.innerText()).replace(/\n/g, '').split('for i in $(seq 1 5)')).toHaveLength(2);
  const stopFrameObservation = await observeTerminalFrames(page, 'VAMPIRE_UNIQUE_0005');

  for (const height of [620, 860, 540, 915]) {
    await page.setViewportSize({ width: 412, height });
    await expect(terminalRows).toContainText('VAMPIRE_UNIQUE_0005');
  }

  expect(await stopFrameObservation()).toEqual({
    blankFrames: 0,
    invalidRowContainerFrames: 0,
    unstableMarkerFrames: 0,
  });

  const renderedText = await terminalRows.innerText();
  for (let index = 1; index <= 5; index += 1) {
    const marker = `VAMPIRE_UNIQUE_${String(index).padStart(4, '0')}`;
    expect(renderedText.split(marker)).toHaveLength(2);
  }
});

test('keeps a full-screen TUI coherent through repeated mobile resizes', async ({ context, page }) => {
  test.setTimeout(60_000);
  await authenticate(context);
  const workspace = await createWorkspace(context);
  workspaceId = workspace.id;

  await page.goto(`/workspaces/${encodeURIComponent(workspace.id)}`);
  await expectTerminalReady(page);
  const composer = page.getByPlaceholder('Compose a message…');
  const tuiCommand = `node -e "const draw=()=>process.stdout.write('\\x1b[?1049h\\x1b[2J\\x1b[H\\x1b[48;5;22m TUI-READY '+process.stdout.columns+'x'+process.stdout.rows+' \\x1b[0m');process.on('SIGWINCH',draw);process.on('SIGINT',()=>{process.stdout.write('\\x1b[?1049l');process.exit(0)});draw();setInterval(()=>{},1000)"`;
  await composer.fill(tuiCommand);
  await composer.press('Enter');
  const terminalRows = page.locator('.xterm-rows');
  await expect(terminalRows).toContainText('TUI-READY');
  await composer.evaluate((element) => element.blur());

  for (const height of [620, 860, 540, 915]) {
    await page.setViewportSize({ width: 412, height });
    await expect(terminalRows).toContainText('TUI-READY');
    await expect
      .poll(() =>
        page.locator('.terminal-frame').evaluate((frame) => {
          const frameBounds = frame.getBoundingClientRect();
          const screenBounds = frame.querySelector('.xterm-screen')?.getBoundingClientRect();
          return Boolean(
            screenBounds &&
              screenBounds.width > 0 &&
              screenBounds.height > 0 &&
              screenBounds.right <= frameBounds.right + 1 &&
              screenBounds.bottom <= frameBounds.bottom + 1
          );
        })
      )
      .toBe(true);
  }

  await page.getByRole('button', { name: 'Ctrl+C' }).click();
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
  const workspaceList = page.getByRole('region', { name: 'Workspace list' });
  await expect(workspaceList.getByRole('button', { name: 'Open settings' })).toBeVisible();
  await workspaceList.getByRole('button', { name: 'Open settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(page.getByRole('radio', { name: /System/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Terminal interaction' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /Open the terminal/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await page.getByRole('button', { name: 'Close settings' }).click();
  await expectTerminalReady(page);
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
  const backgroundTitle = backgroundSheet.locator('.workspace-panel-title strong');
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
  await expect(backgroundSheet.locator('.workspace-panel-title span')).toHaveText(backgroundCommandValue);
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
  await expect(repositoryPanel).toHaveCSS('transition-property', 'transform, visibility');
  await expect(repositoryPanel).toHaveCSS('transition-duration', '0.18s, 0s');
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
  await expect(page.getByPlaceholder('Compose a message…')).toBeVisible();

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
  await expect
    .poll(() =>
      automationPage.evaluate((surface) => {
        const element = surface as HTMLElement;
        element.scrollTop = element.scrollHeight;
        return element.scrollHeight > element.clientHeight && element.scrollTop > 0;
      })
    )
    .toBe(true);
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
  const settingsButton = workspaceList.getByRole('button', { name: 'Open settings' });
  await expect(settingsButton).toBeVisible();
  const settingsCenterDifference = await settingsButton.evaluate((button) => {
    const icon = button.querySelector('svg');
    if (!icon) return Number.POSITIVE_INFINITY;
    const buttonBounds = button.getBoundingClientRect();
    const iconBounds = icon.getBoundingClientRect();
    return Math.abs(iconBounds.x + iconBounds.width / 2 - (buttonBounds.x + buttonBounds.width / 2));
  });
  expect(settingsCenterDifference).toBeLessThan(1);
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
