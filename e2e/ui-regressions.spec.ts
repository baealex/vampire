import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { E2E_WORKSPACE_DIRECTORY } from './runtime.ts';
import { authenticate, createWorkspace, expectTerminalReady, resetStatusPlugins, resetWorkspaces } from './support.ts';

test.beforeEach(async ({ request }) => {
  await resetWorkspaces(request);
});

test('@release organizes settings and manages automations across workspaces', async ({ context, page }) => {
  await authenticate(context);
  const first = await createWorkspace(context);
  const second = await createWorkspace(context);
  for (const [workspace, name] of [[first, 'First review'], [second, 'Second review']] as const) {
    const response = await context.request.post(`/api/workspaces/${workspace.id}/automations`, { data: {
      name, prompt: `Review ${name}`, schedule: { type: 'once', runAt: Date.now() + 3600000 },
    } });
    expect(response.ok()).toBe(true);
  }
  await page.goto(`/workspaces/${first.id}/settings`);
  const workspaceList = page.getByRole('region', { name: 'Workspace list', exact: true });
  await expect(workspaceList).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Workspace name', exact: true })).toBeVisible();
  const managementLayout = await page.evaluate(() => {
    const sidebar = document.querySelector<HTMLElement>('.workspace-column');
    const surface = document.querySelector<HTMLElement>('.management-surface');
    if (!sidebar || !surface) throw new Error('Expected the workspace sidebar and management surface.');
    return { sidebarRight: sidebar.getBoundingClientRect().right, surfaceLeft: surface.getBoundingClientRect().left };
  });
  expect(managementLayout.surfaceLeft).toBeGreaterThanOrEqual(managementLayout.sidebarRight - 1);
  const sections = page.getByRole('navigation', { name: 'Workspace settings sections' });
  await expect(page.getByRole('heading', { name: 'Identity', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await sections.getByRole('button', { name: 'Terminal', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Startup profile', exact: true })).toBeVisible();
  await sections.getByRole('button', { name: 'Automations', exact: true }).click();
  await expect(page.getByText('First review', { exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Workspace' })).toHaveCount(0);
  await expect(sections).toBeVisible();
  await sections.getByRole('button', { name: 'General', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Workspace name', exact: true })).toBeVisible();
  await page.goto(`/settings?workspace=${first.id}`);
  await page.getByRole('navigation', { name: 'App settings sections' }).getByRole('button', { name: 'Shared profiles' }).click();
  await page.getByRole('navigation', { name: 'App settings sections' }).getByRole('button', { name: 'Automations', exact: true }).click();
  const overview = page.locator('.all-automations');
  await expect(overview.getByRole('heading', { name: 'First review' })).toBeVisible();
  await expect(overview.getByRole('heading', { name: 'Second review' })).toBeVisible();
  await overview.getByRole('button', { name: 'Pause First review' }).click();
  await expect(overview.getByRole('button', { name: 'Enable First review' })).toBeVisible();
  await page.getByLabel('Filter by status').selectOption('paused');
  await expect(overview.getByRole('heading', { name: 'Second review' })).toHaveCount(0);
  await page.getByLabel('Filter by status').selectOption('all');
  await page.getByLabel('Search automations').fill('Second');
  await expect(overview.getByRole('heading', { name: 'First review' })).toHaveCount(0);
  await page.getByLabel('Search automations').fill('');
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(overview.getByRole('heading', { name: 'Second review' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await overview.getByRole('button', { name: 'Edit Second review' }).click();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Second review');
  await expect(page.getByRole('heading', { name: 'Edit Second review', exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'App settings sections' })).toBeVisible();
  await overview.getByRole('button', { name: 'Back to automations' }).click();
  await expect(overview).toBeVisible();
  await overview.getByRole('button', { name: 'New automation' }).click();
  await overview.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('');
});

test('protects automation drafts when cancelling or navigating back', async ({ context, page }) => {
  await authenticate(context);
  const workspace = await createWorkspace(context);
  await page.goto(`/workspaces/${workspace.id}/settings?section=automations`);
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

test('lets weekly automations choose individual weekdays', async ({ context, page }) => {
  await authenticate(context);
  const workspace = await createWorkspace(context);
  await page.goto(`/workspaces/${workspace.id}/settings?section=automations`);
  await page.getByRole('button', { name: 'New automation', exact: true }).click();
  await page.locator('.automation-editor select').selectOption('weekly');

  const weekdayPicker = page.locator('.weekday-picker');
  await expect(weekdayPicker.getByRole('button')).toHaveCount(7);
  await expect(weekdayPicker.getByRole('button', { name: 'Mon', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(weekdayPicker.getByRole('button', { name: 'Sun', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await weekdayPicker.getByRole('button', { name: 'Sun', exact: true }).click();
  await weekdayPicker.getByRole('button', { name: 'Mon', exact: true }).click();
  await expect(weekdayPicker.getByRole('button', { name: 'Sun', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(weekdayPicker.getByRole('button', { name: 'Mon', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
});

test('resets nested side-panel views when switching between note and background', async ({ context, page }) => {
  await authenticate(context);
  const workspace = await createWorkspace(context);
  await page.goto(`/workspaces/${workspace.id}`);
  await expectTerminalReady(page);

  const terminalTools = page.getByRole('group', { name: 'Terminal tools' });
  const notePanel = page.locator('.workspace-note-panel');
  const backgroundPanel = page.locator('.background-panel');

  await terminalTools.getByRole('button', { name: /workspace note$/ }).click();
  await notePanel.getByRole('button', { name: 'Ask agent…', exact: true }).click();
  await expect(notePanel.getByRole('heading', { name: 'Ask agent', exact: true })).toBeVisible();

  await terminalTools.getByRole('button', { name: 'Open background processes', exact: true }).click();
  await expect(backgroundPanel).toHaveAccessibleName('Background');
  await backgroundPanel.getByRole('button', { name: 'Ask agent to manage saved commands', exact: true }).click();
  await expect(backgroundPanel.getByRole('heading', { name: 'Ask agent', exact: true })).toBeVisible();

  await terminalTools.getByRole('button', { name: /workspace note$/ }).click();
  await expect(notePanel.getByRole('textbox', { name: 'Workspace note', exact: true })).toBeVisible();
  await expect(notePanel.getByRole('heading', { name: 'Ask agent', exact: true })).toHaveCount(0);

  await terminalTools.getByRole('button', { name: 'Open background processes', exact: true }).click();
  await expect(backgroundPanel).toHaveAccessibleName('Background');
  await expect(backgroundPanel.getByRole('heading', { name: 'Ask agent', exact: true })).toHaveCount(0);
});

test('reviews side panels and project picker at narrow and wide sizes', async ({ context, page }) => {
  execFileSync('git', ['init', '-q'], { cwd: E2E_WORKSPACE_DIRECTORY });
  await authenticate(context);
  const workspace = await createWorkspace(context);
  await context.request.put(`/api/workspaces/${workspace.id}/note`, { data: { note: 'Check retry behavior before changing the connection flow.\n\nNext: add regression coverage.' } });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/workspaces/${workspace.id}`);
    await expectTerminalReady(page);
    await page.getByRole('button', { name: 'Open repository', exact: true }).click();
    await expect(page.locator('.repository-content')).toBeVisible();
    await page.getByRole('tab', { name: 'Git', exact: true }).click();
    await page.getByRole('button', { name: 'Close workspace panel', exact: true }).click();
    await page.getByRole('button', { name: 'Open workspace note', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Workspace note', exact: true })).toHaveValue(/Check retry/);
    await page.getByRole('button', { name: 'Close workspace note', exact: true }).last().click();
    await page.getByRole('button', { name: 'Open background processes', exact: true }).click();
    await page.getByRole('button', { name: 'Run background command', exact: true }).click();
    await page.getByRole('button', { name: 'Close background manager', exact: true }).click();
    if (width < 1024) await page.getByRole('button', { name: 'Open workspaces', exact: true }).click();
    await page.getByRole('button', { name: 'New workspace', exact: true }).click();
    await expect(page.getByText('Loading folders…', { exact: true })).not.toBeVisible();
    const picker = page.getByRole('dialog', { name: 'Open a project', exact: true });
    await expect(picker).toBeVisible();
    await picker.getByRole('button', { name: 'Close', exact: true }).click();
  }
});

test('guides login through token visibility, errors and connection', async ({ page }) => {
  await page.route('**/api/login', (route) => route.fulfill({ status: 401, json: { message: 'Unauthorized' } }));
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Connect to your workspace' })).toBeVisible();
    const token = page.getByLabel('Access token', { exact: true });
    await expect(token).toBeFocused();
    await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled();
    await token.fill('test-token');
    await page.getByRole('button', { name: 'Show token', exact: true }).click();
    await expect(token).toHaveAttribute('type', 'text');
    await page.getByRole('button', { name: 'Hide token', exact: true }).click();
    await expect(token).toHaveAttribute('type', 'password');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('That access token did not work.');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.unroute('**/api/login');
  await page.getByLabel('Access token', { exact: true }).fill('vampire-playwright-token');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Open a project', exact: true })).toBeVisible();
});

test('offers a clear recovery path for ended workspaces', async ({ context, page }) => {
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
    await page.getByRole('button', { name: 'Remove workspace', exact: true }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Remove this workspace?' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'This shell has ended' })).toBeVisible();
  }
  await page.getByRole('button', { name: 'Reopen shell', exact: true }).click();
  await expectTerminalReady(page);
});

test('uses icon menus for ordering and persisted sidebar previews', async ({ context, page }) => {
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
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Workspace view options' }).click();
    await notes.click();
    await last.click();
    await page.keyboard.press('Escape');
    await page.reload();
    if (width < 1024) await page.getByRole('button', { name: 'Open workspaces', exact: true }).click();
    await expect(page.locator('.workspace-note-preview')).toHaveCount(0);
    await expect(page.locator('.workspace-message-preview')).toHaveCount(0);
    await page.getByRole('button', { name: 'Order by', exact: true }).click();
    await expect(page.getByRole('menuitemradio', { name: 'Activity', exact: true })).toHaveAttribute('aria-checked', 'true');
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

test('@release reviews settings navigation, dirty-state protection and modal layout', async ({ context, page }) => {
  await authenticate(context);
  const workspace = await createWorkspace(context);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/settings?workspace=${workspace.id}`);
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const appSections = page.getByRole('navigation', { name: 'App settings sections' });
    await appSections.getByRole('button', { name: 'Status widgets', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/settings\\?workspace=${encodeURIComponent(workspace.id)}$`));
    await expect(page.getByRole('heading', { name: 'Status widgets', exact: true })).toBeVisible();
    await expect(appSections).toBeVisible();
    const limit = page.getByRole('spinbutton', { name: 'Prompts saved per workspace' });
    await appSections.getByRole('button', { name: 'Terminal', exact: true }).click();
    await limit.fill('25');
    await page.getByRole('button', { name: 'Close settings', exact: true }).click();
    const discard = page.getByRole('alertdialog', { name: 'Discard unsaved changes?' });
    await expect(discard).toBeVisible();
    await discard.getByRole('button', { name: 'Keep editing', exact: true }).click();
    await expect(limit).toHaveValue('25');
    await page.getByRole('button', { name: 'Close settings', exact: true }).click();
    await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
    if (width < 1024) await page.getByRole('button', { name: 'Open workspaces', exact: true }).click();
    await page.getByRole('button', { name: 'Inspect listening ports', exact: true }).click();
    const ports = page.getByRole('dialog', { name: 'Listening ports', exact: true });
    await expect(ports).toBeVisible();
    await page.getByRole('searchbox', { name: 'Filter listening ports' }).fill('no-match-for-usability-review');
    await page.keyboard.press('Escape');
    await expect(ports).not.toBeVisible();
    for (const [path, heading] of [
      [`/workspaces/${workspace.id}/settings`, 'Workspace settings'],
      [`/settings?workspace=${workspace.id}&section=widgets`, 'Status widgets'],
      [`/settings?workspace=${workspace.id}&section=automations`, 'Automations'],
    ]) {
      await page.goto(path!);
      await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
      await expect(page.getByText('Loading status widgets…', { exact: true })).not.toBeVisible();
      await expect(page.getByText('Loading automations…', { exact: true })).not.toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
  }
});

test('keeps widget popovers readable on desktop and mobile', async ({ context, page }) => {
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
      await page.getByRole('button', { name: 'Usage: 42% used', exact: true }).click();
      const popup = page.getByRole('dialog', { name: 'Usage details' });
      await expect(popup).toBeVisible();
      await expect(popup.getByRole('heading', { name: 'Usage limits', exact: true })).toBeVisible();
      await expect(popup.getByRole('progressbar', { name: 'Usage', exact: true })).toBeVisible();
      await expect(popup.getByText('Session', { exact: true })).toBeVisible();
      await expect(popup.getByText('Weekly', { exact: true })).toHaveCount(1);
      await popup.getByRole('button', { name: 'Close Usage details' }).click();
      await expect(popup).not.toBeVisible();
    }
  } finally {
    await resetStatusPlugins(context.request);
  }
});

test('recovers from repository loading errors', async ({ context, page }) => {
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
    release();
    const error = page.locator('.repository-panel [role="alert"]');
    await expect(error).toBeVisible();
    await page.unroute('**/repository?*');
    await page.getByRole('button', { name: 'Refresh workspace and Git', exact: true }).click();
    await expect(error).not.toBeVisible();
    await expect(page.locator('.repository-content')).toBeVisible();
  }
});

test('shows image upload feedback and clears it', async ({ context, page }) => {
  await authenticate(context);
  const workspace = await createWorkspace(context);
  let imageUploads = 0;
  // Terminal-specific uploads include a query string; keep this layout test independent of OS clipboard tools.
  await page.route((url) => url.pathname === `/api/workspaces/${workspace.id}/image`, (route) => {
    expect(route.request().method()).toBe('POST');
    imageUploads += 1;
    return route.fulfill({ json: { ok: true } });
  });
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/workspaces/${workspace.id}`);
    await expectTerminalReady(page);
    const previousUploads = imageUploads;
    await page.locator('input[type="file"]').first().setInputFiles({
      name: 'feedback.png',
      mimeType: 'image/png',
      buffer: Buffer.from('mocked image upload'),
    });
    const notice = page.getByText('Image pasted into the shell.', { exact: true });
    await expect.poll(() => imageUploads).toBe(previousUploads + 1);
    await expect(notice).toBeVisible();
    await expect(notice).not.toBeVisible({ timeout: 7_000 });
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
