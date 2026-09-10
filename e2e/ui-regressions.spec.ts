import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { E2E_WORKSPACE_DIRECTORY } from './runtime.ts';
import { authenticate, createWorkspace, expectTerminalReady, resetStatusPlugins, resetWorkspaces } from './support.ts';

test.beforeEach(async ({ request }) => {
  await resetWorkspaces(request);
});

test('virtualizes large repository lists while keeping menus and keyboard navigation usable', async ({ context, page }, testInfo) => {
  execFileSync('git', ['init', '-q'], { cwd: E2E_WORKSPACE_DIRECTORY });
  await authenticate(context);
  const workspace = await createWorkspace(context);
  const files = Array.from({ length: 8000 }, (_, index) => `file-${String(index).padStart(4, '0')}.txt`);
  await page.route(`**/api/workspaces/${workspace.id}/repository?*`, async (route) => {
    const response = await route.fetch();
    const snapshot = await response.json();
    snapshot.files = files;
    snapshot.directories = ['a-folder'];
    snapshot.ignored = [];
    snapshot.changes = files.map((path) => ({ path, status: '??' }));
    snapshot.git.branches = Array.from({ length: 2000 }, (_, index) => ({ name: `branch-${index}`, current: index === 0 }));
    snapshot.git.commits = Array.from({ length: 2000 }, (_, index) => ({ hash: String(index).padStart(40, '0'), shortHash: String(index).padStart(7, '0'), subject: `Commit ${index}`, authorName: 'Test author', authoredAt: 1789039734000, stats: { filesChanged: 1, additions: 13604, deletions: 27369 } }));
    snapshot.git.hasMoreCommits = true;
    await route.fulfill({ response, json: snapshot });
  });
  await page.route(`**/api/workspaces/${workspace.id}/repository/directory?*`, (route) => route.fulfill({ json: { path: 'a-folder', files: ['a-folder/child.txt'], directories: [], ignored: [], truncated: false } }));
  await page.route(`**/api/workspaces/${workspace.id}/repository/commits?*`, (route) => route.fulfill({ json: { hasMore: false, commits: [{ hash: 'new-older-commit', shortHash: 'new-old', subject: 'Older commit loaded', authorName: 'Test author', authoredAt: 1789039734000, stats: { filesChanged: 1, additions: 1, deletions: 0 } }] } }));
  let moves = 0;
  await page.route(`**/api/workspaces/${workspace.id}/repository/move`, async (route) => {
    const body = route.request().postDataJSON();
    expect(body.targetDirectory).toBe('a-folder');
    moves += 1;
    await route.fulfill({ json: { fromPath: body.path, path: `a-folder/${body.path}`, kind: body.kind } });
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/workspaces/${workspace.id}`);
    await expectTerminalReady(page);
    await page.getByRole('button', { name: 'Open repository', exact: true }).click();
    const explorer = page.getByRole('region', { name: 'Repository files', exact: true });
    await explorer.getByRole('button', { name: 'Expand a-folder', exact: true }).click();
    await expect(explorer.getByRole('button', { name: 'Open a-folder/child.txt', exact: true })).toBeVisible();
    await explorer.getByRole('button', { name: 'Collapse a-folder', exact: true }).click();
    const previousMoves = moves;
    await explorer.locator('[data-path="a-folder"]').evaluate((element) => {
      const dataTransfer = new DataTransfer();
      dataTransfer.setData('application/x-vampire-workspace-entry', JSON.stringify({ path: 'file-0000.txt', kind: 'file' }));
      element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
    });
    await expect.poll(() => moves).toBe(previousMoves + 1);
    await expect(explorer.getByRole('button', { name: 'Collapse a-folder', exact: true })).toBeVisible();
    await explorer.press('End');
    const lastFile = explorer.getByRole('button', { name: 'Open file-7999.txt', exact: true });
    await expect(lastFile).toBeFocused();
    await expect(lastFile).toBeInViewport();
    expect(await explorer.locator('[data-virtual-key]').count()).toBeLessThan(150);
    await lastFile.press('F2');
    await expect(page.getByRole('dialog', { name: 'Rename entry' })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await explorer.getByRole('button', { name: 'Actions for file file-7999.txt', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: 'Copy', exact: true })).toBeVisible();
    await page.locator('[aria-label="Repository files"]').evaluate((element) => { element.scrollTop = 0; });
    await expect(page.getByRole('menuitem', { name: 'Copy', exact: true })).toBeVisible();
    await expect(page.locator('[data-path="file-7999.txt"]')).toHaveCount(1);
    await page.locator('[aria-label="Repository files"]').evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await page.getByRole('menuitem', { name: 'Copy', exact: true }).click();
    await page.getByRole('button', { name: 'Add inside workspace root', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: 'Paste', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('tab', { name: 'Git', exact: true }).click();
    for (const [tab, label, last] of [['Changes', 'Changed files', 'file-7999.txt'], ['Branches', 'Branches', 'branch-1999'], ['Commits', 'Commit history', 'Commit 1999']]) {
      await page.getByRole('tab', { name: new RegExp(`^${tab}`) }).click();
      const list = page.getByRole('region', { name: label, exact: true });
      await expect(list.locator('[data-virtual-key]').first()).toBeVisible();
      await list.press('End');
      await expect(list.getByText(last, { exact: true })).toBeInViewport();
      expect(await list.locator('[data-virtual-key]').count()).toBeLessThan(150);
      await page.screenshot({ path: testInfo.outputPath(`${tab}-${width}.png`) });
      await list.press('Home');
      await expect(list.locator('[data-index="0"]')).toBeInViewport();
    }
    await expect(page.getByRole('button', { name: 'Load older commits', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Load older commits', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Load older commits', exact: true })).toHaveCount(0);
    await page.getByRole('region', { name: 'Commit history', exact: true }).press('End');
    await expect(page.getByText('Older commit loaded', { exact: true })).toBeInViewport();
    await page.getByRole('button', { name: 'Close workspace panel', exact: true }).click({ timeout: 3000 });
  }
});

test('keeps commit line counts on a separate unclipped row', async ({ context, page }, testInfo) => {
  execFileSync('git', ['init', '-q'], { cwd: E2E_WORKSPACE_DIRECTORY });
  await authenticate(context);
  const workspace = await createWorkspace(context);
  await page.route(`**/api/workspaces/${workspace.id}/repository?*`, async (route) => {
    const response = await route.fetch();
    const snapshot = await response.json();
    snapshot.git.commits = [{ hash: 'c63d87014f1110a26d0bd561cf8045b9e1783a8b', shortHash: 'c63d870', subject: 'wip: checkpoint react fastify migration', authorName: 'Jino Bae', authoredAt: 1789039734000, stats: { additions: 13604, deletions: 27369, filesChanged: 300 } }];
    await route.fulfill({ response, json: snapshot });
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route(`**/api/workspaces/${workspace.id}/repository/commit?*`, (route) => route.fulfill({ json: {
    hash: 'c63d87014f1110a26d0bd561cf8045b9e1783a8b',
    patch: ['diff --git a/large.txt b/large.txt', '--- a/large.txt', '+++ b/large.txt', '@@ -0,0 +1,41000 @@', ...Array.from({ length: 41000 }, (_, index) => `+large-commit-line-${index}`)].join('\n'),
  } }));
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/workspaces/${workspace.id}`);
    await expectTerminalReady(page);
    await page.getByRole('button', { name: 'Open repository', exact: true }).click();
    await page.getByRole('tab', { name: 'Git', exact: true }).click();
    await page.getByRole('tab', { name: 'Commits', exact: true }).click();
    const item = page.getByRole('button').filter({ hasText: 'wip: checkpoint react fastify migration' });
    await expect(item).toBeVisible();
    const geometry = await item.evaluate((element) => {
      const meta = element.querySelector('time')!.getBoundingClientRect();
      const counts = Array.from(element.querySelectorAll('[aria-label$="lines added"], [aria-label$="lines deleted"]'));
      return counts.map((count) => ({ below: count.getBoundingClientRect().top >= meta.bottom, fits: count.scrollWidth <= count.clientWidth, inside: count.getBoundingClientRect().right <= element.getBoundingClientRect().right }));
    });
    expect(geometry).toHaveLength(2);
    expect(geometry.every((count) => count.below && count.fits && count.inside)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`commit-list-${width}.png`) });
    await item.click();
    const changes = page.getByRole('region', { name: 'Changes', exact: true });
    await expect(changes.locator('.diff-line').first()).toBeVisible();
    expect(await changes.locator('.diff-line').count()).toBeLessThan(200);
    await changes.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect(changes.getByText('+large-commit-line-40999', { exact: true })).toBeVisible();
    expect(await changes.locator('.diff-line').count()).toBeLessThan(200);
    await page.screenshot({ path: testInfo.outputPath(`large-commit-${width}.png`) });
    await page.getByRole('button', { name: 'Close file and return to terminal', exact: true }).click({ timeout: 3000 });
    await expect(changes).toHaveCount(0);
  }
});

test('protects automation drafts when cancelling or navigating back', async ({ context, page }) => {
  await authenticate(context);
  const workspace = await createWorkspace(context);
  await page.goto(`/workspaces/${workspace.id}/automations`);
  await page.getByRole('button', { name: 'New automation', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'New automation', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Keep my draft');
  await page.getByRole('button', { name: 'Back to automations', exact: true }).click();
  const confirmation = page.getByRole('alertdialog', { name: 'Discard unsaved changes?' });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: 'Keep editing' }).click();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Keep my draft');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await confirmation.getByRole('button', { name: 'Discard changes' }).click();
  await expect(page.getByRole('button', { name: 'New automation', exact: true })).toBeVisible();
});

test('reviews side panels and project picker at narrow and wide sizes', async ({ context, page }, testInfo) => {
  execFileSync('git', ['init', '-q'], { cwd: E2E_WORKSPACE_DIRECTORY });
  await authenticate(context);
  const workspace = await createWorkspace(context);
  await context.request.put(`/api/workspaces/${workspace.id}/note`, { data: { note: 'Check retry behavior before changing the connection flow.\n\nNext: add regression coverage.' } });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/workspaces/${workspace.id}`);
    await expectTerminalReady(page);
    await page.getByRole('button', { name: 'Open repository', exact: true }).click();
    await expect(page.locator('.repository-content')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`explorer-${width}.png`) });
    await page.getByRole('tab', { name: 'Git', exact: true }).click();
    await page.screenshot({ path: testInfo.outputPath(`git-${width}.png`) });
    await page.getByRole('button', { name: 'Close workspace panel', exact: true }).click();
    await page.getByRole('button', { name: 'Open workspace note', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Workspace note', exact: true })).toHaveValue(/Check retry/);
    await page.screenshot({ path: testInfo.outputPath(`note-${width}.png`) });
    await page.getByRole('button', { name: 'Close workspace note', exact: true }).last().click();
    await page.getByRole('button', { name: 'Open background processes', exact: true }).click();
    await page.getByRole('button', { name: 'Run background command', exact: true }).click();
    await page.screenshot({ path: testInfo.outputPath(`background-${width}.png`) });
    await page.getByRole('button', { name: 'Close background manager', exact: true }).click();
    if (width < 1024) await page.getByRole('button', { name: 'Open workspaces', exact: true }).click();
    await page.getByRole('button', { name: 'New workspace', exact: true }).click();
    await expect(page.getByText('Loading folders…', { exact: true })).not.toBeVisible();
    const picker = page.getByRole('dialog', { name: 'Open a project', exact: true });
    await expect(picker).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`project-picker-${width}.png`) });
    await picker.getByRole('button', { name: 'Close', exact: true }).click();
  }
});

test('guides login through token visibility, errors and connection', async ({ page }, testInfo) => {
  await page.route('**/api/login', (route) => route.fulfill({ status: 401, json: { message: 'Unauthorized' } }));
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Connect to your workspace' })).toBeVisible();
    const token = page.getByLabel('Access token', { exact: true });
    await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled();
    await token.fill('test-token');
    await page.getByRole('button', { name: 'Show token', exact: true }).click();
    await expect(token).toHaveAttribute('type', 'text');
    await page.getByRole('button', { name: 'Hide token', exact: true }).click();
    await expect(token).toHaveAttribute('type', 'password');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('That access token did not work.');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`login-${width}.png`) });
  }
  await page.unroute('**/api/login');
  await page.getByLabel('Access token', { exact: true }).fill('vampire-playwright-token');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Open a project', exact: true })).toBeVisible();
});

test('offers a clear recovery path for ended workspaces', async ({ context, page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await authenticate(context);
  const workspace = await createWorkspace(context);
  expect((await context.request.post(`/api/workspaces/${workspace.id}/close`)).ok()).toBe(true);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`/workspaces/${workspace.id}`);
    await expect(page.getByRole('heading', { name: 'This shell has ended' })).toBeVisible();
    await page.getByRole('button', { name: 'Reopen with…', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: 'Blank terminal', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`ended-${width}.png`) });
    await page.getByRole('button', { name: 'Remove workspace', exact: true }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Remove this workspace?' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'This shell has ended' })).toBeVisible();
  }
  await page.getByRole('button', { name: 'Reopen shell', exact: true }).click();
  await expectTerminalReady(page);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 800 });
    await page.screenshot({ path: testInfo.outputPath(`terminal-review-${width}.png`) });
    const metrics = await page.locator('.terminal-header').evaluate((header) => {
      const title = header.querySelector('.terminal-identity-title strong')!;
      const subtitle = header.querySelector('.terminal-identity > span');
      return { height: header.getBoundingClientRect().height, title: title.textContent, subtitle: subtitle?.textContent,
        titleWidth: title.getBoundingClientRect().width, subtitleFont: subtitle ? getComputedStyle(subtitle).fontSize : null };
    });
    expect(metrics.titleWidth).toBeGreaterThan(24);
    await testInfo.attach(`terminal-header-${width}`, { body: JSON.stringify(metrics), contentType: 'application/json' });
  }
});

test('uses icon menus for ordering and persisted sidebar previews', async ({ context, page }, testInfo) => {
  await authenticate(context);
  const workspace = await createWorkspace(context);
  const noteText = 'Review the checkout flow and keep the existing payment integration unchanged.';
  const messageText = 'Check the retry behavior when the connection drops, then add a regression test for the recovery path.';
  expect((await context.request.put(`/api/workspaces/${workspace.id}/note`, { data: { note: noteText } })).ok()).toBe(true);
  expect((await context.request.post(`/api/workspaces/${workspace.id}/composer-prompts`, { data: { prompt: messageText } })).ok()).toBe(true);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/workspaces/${workspace.id}`);
    await expectTerminalReady(page);
    if (width < 1024) await page.getByRole('button', { name: 'Open workspaces', exact: true }).click();
    await page.getByRole('button', { name: 'Workspace view options' }).click();
    const notes = page.getByRole('menuitemcheckbox', { name: 'Show notes', exact: true });
    const last = page.getByRole('menuitemcheckbox', { name: 'Show last message', exact: true });
    if (await notes.getAttribute('aria-checked') === 'false') await notes.click();
    if (await last.getAttribute('aria-checked') === 'false') await last.click();
    await expect(page.locator('.workspace-note-preview')).toHaveText(noteText);
    await expect(page.locator('.workspace-message-preview')).toHaveText(messageText);
    await page.screenshot({ path: testInfo.outputPath(`sidebar-options-${width}.png`) });
    await page.keyboard.press('Escape');
    await page.screenshot({ path: testInfo.outputPath(`sidebar-previews-${width}.png`) });
    await page.getByRole('button', { name: 'Workspace view options' }).click();
    await notes.click();
    await last.click();
    await page.keyboard.press('Escape');
    await page.screenshot({ path: testInfo.outputPath(`sidebar-previews-hidden-${width}.png`) });
    await page.reload();
    if (width < 1024) await page.getByRole('button', { name: 'Open workspaces', exact: true }).click();
    await expect(page.locator('.workspace-note-preview')).toHaveCount(0);
    await expect(page.locator('.workspace-message-preview')).toHaveCount(0);
    await page.getByRole('button', { name: 'Order by', exact: true }).click();
    await expect(page.getByRole('menuitemradio', { name: 'Activity', exact: true })).toHaveAttribute('aria-checked', 'true');
    await page.screenshot({ path: testInfo.outputPath(`sidebar-order-${width}.png`) });
    await page.getByRole('menuitemradio', { name: 'Manual', exact: true }).click();
    await expect(page.locator('.workspace-drag-handle')).toHaveCount(1);
    await page.getByRole('button', { name: 'Order by', exact: true }).click();
    await page.getByRole('menuitemradio', { name: 'Activity', exact: true }).click();
    await expect(page.locator('.workspace-row')).toBeEnabled();
    await expect(page.locator('.workspace-actions-menu .vampire-menu-trigger')).toBeEnabled();
    await page.locator('.workspace-actions-menu .vampire-menu-trigger').click();
    await expect(page.getByRole('menuitem', { name: 'Workspace settings', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
  }
});

test('reviews settings navigation, dirty-state protection and modal layout', async ({ context, page }, testInfo) => {
  await authenticate(context);
  const workspace = await createWorkspace(context);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/settings?workspace=${workspace.id}`);
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`settings-${width}.png`) });
    const limit = page.getByRole('spinbutton', { name: 'Prompts saved per workspace' });
    await limit.fill('25');
    await page.getByRole('button', { name: 'Close settings', exact: true }).click();
    const discard = page.getByRole('alertdialog', { name: 'Discard unsaved changes?' });
    await expect(discard).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`discard-${width}.png`) });
    await discard.getByRole('button', { name: 'Keep editing', exact: true }).click();
    await expect(limit).toHaveValue('25');
    await page.getByRole('button', { name: 'Close settings', exact: true }).click();
    await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
    if (width < 1024) await page.getByRole('button', { name: 'Open workspaces', exact: true }).click();
    await page.getByRole('button', { name: 'Inspect listening ports', exact: true }).click();
    const ports = page.getByRole('dialog', { name: 'Listening ports', exact: true });
    await expect(ports).toBeVisible();
    await page.getByRole('searchbox', { name: 'Filter listening ports' }).fill('no-match-for-usability-review');
    await page.screenshot({ path: testInfo.outputPath(`ports-${width}.png`) });
    const box = (await ports.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    await page.keyboard.press('Escape');
    await expect(ports).not.toBeVisible();
    for (const [path, heading, filename] of [
      [`/workspaces/${workspace.id}/settings`, 'Workspace settings', 'workspace-settings'],
      [`/settings/widgets?workspace=${workspace.id}`, 'Status widgets', 'widgets'],
      [`/workspaces/${workspace.id}/automations`, 'Agent automations', 'automations'],
    ]) {
      await page.goto(path!);
      await expect(page.getByRole('heading', { name: heading!, exact: true })).toBeVisible();
      await expect(page.getByText('Loading status widgets…', { exact: true })).not.toBeVisible();
      await expect(page.getByText('Loading automations…', { exact: true })).not.toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`${filename}-${width}.png`) });
    }
  }
});

test('keeps widget popovers readable and contained on desktop and mobile', async ({ context, page }, testInfo) => {
  await authenticate(context);
  const workspace = await createWorkspace(context);
  const output = {
    text: '42% used', progress: 42,
    menu: [
      { type: 'heading', text: 'Usage limits', badge: 'Overall' },
      { type: 'item', text: 'Session', value: '42%', detail: 'Five-hour usage window', progress: 42, time: { label: 'Resets', at: 1789099200000 } },
      { type: 'item', text: 'Weekly', value: '78%', progress: 78, tone: 'warning' },
      { type: 'separator' },
      { type: 'item', text: 'View usage details', detail: 'Account usage and limits', href: 'https://example.com/usage' },
    ],
  };
  const response = await context.request.put('/api/status-plugins', { data: { plugins: [{
    id: 'visual-widget', name: 'Usage', enabled: true, intervalMs: 60000,
    source: { type: 'command', command: `printf '%s' '${JSON.stringify(output)}'` },
  }] } });
  expect(response.ok()).toBe(true);
  try {
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 700 });
      await page.goto(`/workspaces/${workspace.id}`);
      await expectTerminalReady(page);
      const before = await page.locator('.terminal-frame').boundingBox();
      await page.getByRole('button', { name: 'Usage: 42% used', exact: true }).click();
      const popup = page.getByRole('dialog', { name: 'Usage details' });
      await expect(popup).toBeVisible();
      const box = (await popup.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(7);
      expect(box.x + box.width).toBeLessThanOrEqual(width - 7);
      expect(box.y + box.height).toBeLessThanOrEqual(700);
      expect(await popup.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      const progress = (await popup.getByRole('progressbar', { name: 'Usage', exact: true }).boundingBox())!;
      const firstRow = (await popup.getByText('Session', { exact: true }).boundingBox())!;
      expect(progress.y + progress.height).toBeLessThan(firstRow.y);
      expect(await page.locator('.terminal-frame').boundingBox()).toEqual(before);
      await page.screenshot({ path: testInfo.outputPath(`widget-${width}.png`) });
      await popup.getByRole('button', { name: 'Close Usage details' }).click();
      await expect(popup).not.toBeVisible();
    }
  } finally {
    await resetStatusPlugins(context.request);
  }
});

test('gives repository loading and errors breathing room without resizing the terminal', async ({ context, page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await authenticate(context);
  const workspace = await createWorkspace(context);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    await page.route('**/repository?*', async (route) => {
      await pending;
      await route.fulfill({ status: 500, json: { message: `Unable to read /${'long-directory-name/'.repeat(16)}` } });
    });
    await page.goto(`/workspaces/${workspace.id}`);
    await expectTerminalReady(page);
    await page.getByRole('button', { name: 'Open repository', exact: true }).click();
    const loading = page.getByRole('status').filter({ hasText: 'Loading repository…' });
    await expect(loading).toBeVisible();
    if (width < 1024) {
      await expect.poll(async () => (await page.locator('.repository-panel').boundingBox())!.x).toBe(0);
    }
    const spacing = await loading.evaluate((element) => {
      const text = element.querySelector('span:last-child')!.getBoundingClientRect();
      const box = element.getBoundingClientRect();
      return { top: text.top - box.top, bottom: box.bottom - text.bottom };
    });
    expect(spacing.top).toBeGreaterThanOrEqual(32);
    expect(spacing.bottom).toBeGreaterThanOrEqual(32);
    const before = await page.locator('.terminal-frame').boundingBox();
    await page.screenshot({ path: testInfo.outputPath(`repository-loading-${width}.png`) });
    release();
    const error = page.locator('.repository-panel [role="alert"]');
    await expect(error).toBeVisible();
    expect(await error.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.locator('.terminal-frame').boundingBox()).toEqual(before);
    await page.screenshot({ path: testInfo.outputPath(`repository-error-${width}.png`) });
    await page.unroute('**/repository?*');
    await page.getByRole('button', { name: 'Refresh workspace and Git', exact: true }).click();
    await expect(error).not.toBeVisible();
    await expect(page.locator('.repository-content')).toBeVisible();
    expect(await page.locator('.terminal-frame').boundingBox()).toEqual(before);
  }
});

test('keeps terminal geometry fixed while floating image feedback appears and clears', async ({ context, page }) => {
  await authenticate(context);
  const workspace = await createWorkspace(context);
  await page.route('**/api/workspaces/*/image', (route) => route.fulfill({ json: { ok: true } }));
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/workspaces/${workspace.id}`);
    await expectTerminalReady(page);
    const frame = page.locator('.terminal-frame');
    const before = await frame.boundingBox();
    await page.locator('input[type="file"]').first().setInputFiles({
      name: 'feedback.png',
      mimeType: 'image/png',
      buffer: Buffer.from('mocked image upload'),
    });
    const notice = page.getByText('Image pasted into the shell.', { exact: true });
    await expect(notice).toBeVisible();
    expect(await frame.boundingBox()).toEqual(before);
    await expect(notice).not.toBeVisible({ timeout: 7_000 });
    expect(await frame.boundingBox()).toEqual(before);
  }
});

test('reorders manual workspaces with dnd-kit handles and persists the order', async ({ context, page }) => {
  await authenticate(context);
  const workspaces = [];
  for (let index = 0; index < 3; index++) workspaces.push(await createWorkspace(context));
  await page.goto(`/workspaces/${workspaces[0]!.id}`);
  await page.getByRole('button', { name: 'Order by', exact: true }).click();
    await page.getByRole('menuitemradio', { name: 'Manual', exact: true }).click();
  const rows = page.locator('.workspaces .workspace-row');
  const order = () => rows.evaluateAll((elements) => elements.map((element) => element.getAttribute('data-workspace-id')));
  const initial = await order();
  const handles = page.locator('.workspace-drag-handle');
  await handles.first().focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Space');
  await expect.poll(order).toEqual([initial[1], initial[0], initial[2]]);
  const beforePointer = await order();
  const source = await handles.first().boundingBox();
  const target = await handles.last().boundingBox();
  expect(source).not.toBeNull();
  expect(target).not.toBeNull();
  await page.mouse.move(source!.x + source!.width / 2, source!.y + source!.height / 2);
  await page.mouse.down();
  await page.mouse.move(source!.x + source!.width / 2, source!.y + source!.height / 2 + 10, { steps: 3 });
  await page.mouse.move(target!.x + target!.width / 2, target!.y + target!.height / 2, { steps: 15 });
  await page.mouse.up();
  await expect.poll(order).toEqual([beforePointer[1], beforePointer[2], beforePointer[0]]);
  const persisted = await order();
  await page.reload();
  await expect.poll(order).toEqual(persisted);
  await page.getByRole('button', { name: 'Order by', exact: true }).click();
    await page.getByRole('menuitemradio', { name: 'Activity', exact: true }).click();
  await expect(handles).toHaveCount(0);
});
