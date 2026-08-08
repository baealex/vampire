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
	await expect.poll(() => terminalRows.innerText()).toContain('200');
	await page.getByRole('button', { name: 'Scroll to terminal top' }).click();
	await expect.poll(async () => !(await terminalRows.innerText()).includes('200')).toBe(true);
	await page.getByRole('button', { name: 'Scroll to terminal bottom' }).click();
	await expect.poll(() => terminalRows.innerText()).toContain('200');

	const runBackground = page.getByRole('button', { name: 'Run background command' });
	await expect(runBackground).toBeVisible();
	await expect.poll(() => page.evaluate(() => {
		const bar = document.querySelector<HTMLElement>('.background-bar');
		const toggle = document.querySelector<HTMLElement>('.background-toggle');
		if (!bar || !toggle) return false;
		const barBox = bar.getBoundingClientRect();
		const toggleBox = toggle.getBoundingClientRect();
		return Math.abs(barBox.left - toggleBox.left) < 1 && Math.abs(barBox.right - toggleBox.right) < 1;
	})).toBe(true);
	await runBackground.click();
	await page.getByRole('textbox', { name: 'Background command' }).fill('sleep 30');
	await page.getByRole('button', { name: 'Run', exact: true }).click();
	const stopBackground = page.getByRole('button', { name: 'Stop sleep 30' });
	await expect(stopBackground).toBeVisible();
	await expect.poll(() => stopBackground.evaluate((button) => button.getBoundingClientRect().right <= window.innerWidth)).toBe(true);
	await stopBackground.click();
	await expect(stopBackground).toBeHidden();

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
	await page.getByRole('tab', { name: 'Files' }).click();
	await page.getByRole('button', { name: 'Open conflict.txt' }).click();
	await expect(page.locator('[aria-label="Edit conflict.txt"] .cm-content')).toBeVisible({ timeout: 15_000 });
	await page.getByRole('button', { name: 'Close file and return to terminal' }).click();
	await expect(page.getByRole('textbox', { name: 'Terminal input' })).toBeVisible();
});
