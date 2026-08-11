import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, test, type WebSocketRoute } from '@playwright/test';
import { authenticate, createSession, expectTerminalReady, removeSession, resetSessions } from './support.ts';

let sessionId: string | undefined;
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
	sessionId = undefined;
	await resetSessions(request);
});

test.afterEach(async ({ context }) => {
	await removeSession(context, sessionId);
	sessionId = undefined;
});

test('keeps a terminal connection failure inside the mobile viewport', async ({ context, page }) => {
	await authenticate(context);
	const session = await createSession(context);
	sessionId = session.id;
	await page.routeWebSocket(/\/ws\/terminal(?:\?|$)/, (socket) => {
		socket.close({ code: 1008, reason: 'authentication expired' });
	});

	await page.goto(`/sessions/${encodeURIComponent(session.id)}`);
	const terminalFrame = page.locator('.terminal-frame');
	const connectionError = page.locator('.terminal-error');
	await expect(connectionError).toContainText('This terminal session is no longer authorized.');
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
	const session = await createSession(context);
	sessionId = session.id;

	await page.goto(`/sessions/${encodeURIComponent(session.id)}`);
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
			textarea.dispatchEvent(new CompositionEvent('compositionupdate', {
				bubbles: true,
				data: compositionValue
			}));
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
	await expect.poll(() => terminal.evaluate((element) => {
		const screen = element.querySelector<HTMLElement>('.xterm-screen');
		const bounds = screen?.getBoundingClientRect();
		return Boolean(bounds && bounds.width > 0 && bounds.height > 0);
	})).toBe(true);

	await terminalInput.evaluate((input, value) => {
		(input as HTMLTextAreaElement).dispatchEvent(
			new CompositionEvent('compositionend', { bubbles: true, data: value })
		);
	}, 'printf 모바일-IME-확인');
	await page.waitForTimeout(50);
	await expect(composition).not.toHaveClass(/active/);
	await terminalInput.press('Enter');
	await expect(page.locator('.xterm-rows')).toContainText('모바일-IME-확인');
	await expect.poll(() => sentTerminalMessages.map(websocketMessageType).filter((type) => type === 'resize').length)
		.toBeGreaterThan(0);
	await expect(terminalInput).toBeFocused();
});

test('defers a reconnect snapshot until terminal IME composition finishes', async ({ context, page }) => {
	test.setTimeout(60_000);
	await authenticate(context);
	const session = await createSession(context);
	sessionId = session.id;

	let firstConnection: WebSocketRoute | undefined;
	let resolveFirstConnection!: () => void;
	let resolveSecondSnapshot!: () => void;
	const firstConnectionOpened = new Promise<void>((resolve) => { resolveFirstConnection = resolve; });
	const secondSnapshotReceived = new Promise<void>((resolve) => { resolveSecondSnapshot = resolve; });
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

	await page.goto(`/sessions/${encodeURIComponent(session.id)}`);
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
	const session = await createSession(context);
	sessionId = session.id;

	await page.goto(`/sessions/${encodeURIComponent(session.id)}`);
	await expectTerminalReady(page);
	await expect(page.locator('.terminal-header .system-metrics')).toBeVisible();
	await expect(page.locator('.terminal-header .system-metric').first().locator('output')).toContainText('≈');
	await expect(page.getByRole('button', { name: 'Inspect listening ports' })).toBeVisible();
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
	const hasVisibleOutputLine = (value: string) => terminalRows.evaluate((rows, expected) =>
		Array.from(rows.children).some((row) => row.textContent?.trim() === expected), value);
	await expect.poll(() => hasVisibleOutputLine('200')).toBe(true);
	await page.getByRole('button', { name: 'Scroll to terminal top' }).click();
	await expect.poll(() => hasVisibleOutputLine('200')).toBe(false);
	await page.getByRole('button', { name: 'Scroll to terminal bottom' }).click();
	await expect.poll(() => hasVisibleOutputLine('200')).toBe(true);

	const openBackground = page.getByRole('button', { name: 'Open background processes' });
	await expect(openBackground).toBeVisible();
	await expect(page.getByRole('button', { name: 'Run background command' })).toHaveCount(0);
	await openBackground.click();
	const backgroundSheet = page.getByRole('dialog', { name: 'Background processes' });
	const backgroundTitle = backgroundSheet.getByRole('heading', { name: 'Background processes' });
	await expect(backgroundSheet).toBeVisible();
	await expect(page.getByRole('textbox', { name: 'Background command' })).toHaveCount(0);
	await backgroundSheet.getByRole('button', { name: 'Run background command' }).click();
	const backgroundCommand = page.getByRole('textbox', { name: 'Background command' });
	await expect(backgroundCommand).toBeFocused();
	await page.setViewportSize({ width: 412, height: 640 });
	await expect(backgroundCommand).toBeFocused();
	const sheetHeightBeforeOutput = await backgroundSheet.evaluate((sheet) => sheet.getBoundingClientRect().height);
	const backgroundCommandValue = 'seq 1 300; sleep 30';
	await backgroundCommand.fill(backgroundCommandValue);
	await backgroundSheet.getByRole('button', { name: 'Run', exact: true }).click();
	await expect(backgroundCommand).toHaveCount(0);
	const output = backgroundSheet
		.getByRole('region', { name: `Output for ${backgroundCommandValue}` })
		.locator('pre');
	await expect(output).toContainText('300');
	const stopBackground = page.getByRole('button', { name: `Stop ${backgroundCommandValue}` });
	await expect(stopBackground).toBeVisible();
	const titleTopBeforeScroll = await backgroundTitle.evaluate((title) => title.getBoundingClientRect().top);
	const sheetLayout = await backgroundSheet.evaluate((sheet) => {
		const bounds = sheet.getBoundingClientRect();
		const viewport = window.visualViewport;
		const top = viewport?.offsetTop ?? 0;
		const bottom = top + (viewport?.height ?? window.innerHeight);
		return {
			fitsViewport: bounds.top >= top - 1 && bounds.bottom <= bottom + 1,
			height: bounds.height
		};
	});
	const outputScrolls = await output.evaluate((terminalOutput) => {
		terminalOutput.scrollTop = terminalOutput.scrollHeight;
		return terminalOutput.scrollHeight > terminalOutput.clientHeight && terminalOutput.scrollTop > 0;
	});
	expect(sheetLayout.fitsViewport).toBe(true);
	expect(Math.abs(sheetLayout.height - sheetHeightBeforeOutput)).toBeLessThan(1);
	expect(outputScrolls).toBe(true);
	const titleTopAfterScroll = await backgroundTitle.evaluate((title) => title.getBoundingClientRect().top);
	expect(Math.abs(titleTopAfterScroll - titleTopBeforeScroll)).toBeLessThan(1);
	await stopBackground.click();
	await expect(stopBackground).toBeHidden();
	await backgroundSheet.getByRole('button', { name: 'Close background manager' }).click();
	await expect(backgroundSheet).toBeHidden();
	await expect(openBackground).toBeFocused();
	await page.setViewportSize({ width: 412, height: 915 });

	await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

	await page.getByRole('button', { name: 'Open workspaces' }).click();
	await expect(page.getByRole('heading', { name: 'Workspaces' })).toBeVisible();
	await run('tmux', ['send-keys', '-t', session.tmuxSession, '-l', '--', "printf 'unobserved-mobile-output\\n'"]);
	await run('tmux', ['send-keys', '-t', session.tmuxSession, 'Enter']);
	await page.getByRole('button', { name: /Open running workspace workspace/ }).click();
	await expectTerminalReady(page);
	await expect.poll(() => pageErrors.filter((message) => message.includes('effect_update_depth_exceeded'))).toEqual([]);

	await page.getByRole('button', { name: 'Open repository' }).click();
	const repositoryPanel = page.getByRole('complementary', { name: 'Repository for workspace' });
	await expect(repositoryPanel).toBeVisible();
	await expect(repositoryPanel).toHaveCSS('transition-property', 'transform');
	await expect(repositoryPanel).toHaveCSS('transition-duration', '0.18s');
	await expect(page.getByRole('tab', { name: 'Files' })).toBeVisible();
	await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	await page.getByRole('button', { name: 'Add workspace item' }).click();
	await expect(page.getByRole('menuitem', { name: 'Choose files…' })).toBeVisible();
	await expect(page.getByRole('menuitem', { name: 'Choose folder…' })).toBeVisible();
	await page.keyboard.press('Escape');
	await page.getByRole('tab', { name: 'Files' }).click();
	const conflictActions = page.getByRole('button', { name: 'Actions for file conflict.txt' });
	await expect(conflictActions).toBeVisible();
	await conflictActions.click();
	await expect(page.getByRole('menuitem', { name: 'Insert path into terminal' })).toBeVisible();
	await expect(page.getByRole('menuitem', { name: 'Delete' })).toBeVisible();
	await page.getByRole('menuitem', { name: 'Insert path into terminal' }).click();
	await expect(repositoryPanel).toBeHidden();
	await expect(page.locator('.xterm-rows')).toContainText('conflict.txt');
	await page.getByRole('button', { name: 'Open repository' }).click();
	await page.getByRole('tab', { name: 'Files' }).click();
	await page.getByRole('button', { name: 'Open conflict.txt' }).click();
	await expect(page.locator('[aria-label="Edit conflict.txt"] .cm-content')).toBeVisible({ timeout: 15_000 });
	await page.getByRole('button', { name: 'Close file and return to terminal' }).click();
	await expect(page.getByRole('textbox', { name: 'Terminal input' })).toBeVisible();
});
