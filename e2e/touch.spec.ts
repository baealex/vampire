import { expect, test } from '@playwright/test';
import { authenticate, createWorkspace, expectTerminalReady, resetStatusPlugins, resetWorkspaces } from './support.ts';

test.beforeEach(async ({ request }) => Promise.all([resetWorkspaces(request), resetStatusPlugins(request)]));

test('scrolls status widgets without opening a popover', async ({ context, page }) => {
  await authenticate(context);
  const workspace = await createWorkspace(context);
  const plugins = Array.from({ length: 8 }, (_, index) => ({
    id: `touch-widget-${index}`,
    name: `Widget ${index + 1}`,
    enabled: true,
    intervalMs: 60_000,
    source: { type: 'command', command: `printf '%s' '{"text":"${index + 1}%"}'` },
  }));
  const response = await context.request.put('/api/status-plugins', { data: { plugins } });
  expect(response.ok()).toBe(true);

  await page.goto(`/workspaces/${encodeURIComponent(workspace.id)}`);
  await expectTerminalReady(page);
  const bar = page.getByRole('region', { name: 'Server status plugins' });
  const firstWidget = bar.getByRole('button', { name: 'Widget 1: 1%', exact: true });
  await expect(firstWidget).toBeVisible();
  await expect.poll(() => bar.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  const box = await firstWidget.boundingBox();
  expect(box).not.toBeNull();
  const session = await context.newCDPSession(page);
  const start = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };

  await session.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ ...start, id: 61 }],
  });
  for (const distance of [24, 56, 96]) {
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: start.x - distance, y: start.y, id: 61 }],
    });
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

  await expect.poll(() => bar.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  await expect(page.locator('.status-plugin-popover')).toHaveCount(0);
});

test('reorders manual workspaces with a vertical touch drag', async ({ context, page }) => {
  await authenticate(context);
  const workspaces = await Promise.all([createWorkspace(context), createWorkspace(context), createWorkspace(context)]);
  await page.goto(`/workspaces/${encodeURIComponent(workspaces[0]!.id)}`);
  await expectTerminalReady(page);
  await page.getByRole('button', { name: 'Open workspaces', exact: true }).click();
  await page.getByRole('button', { name: 'Order by', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Manual', exact: true }).click();

  const rows = page.locator('.workspaces .workspace-row');
  const order = () =>
    rows.evaluateAll((elements) => elements.map((element) => element.getAttribute('data-workspace-id')));
  const initial = await order();
  const source = page
    .locator('.workspace-row-shell:not([data-dnd-placeholder])')
    .filter({ has: page.locator(`[data-workspace-id="${initial[0]}"]`) });
  const sourceHandle = source.getByRole('button', { name: /^Reorder /u });
  const targetHandle = page.locator('.workspace-drag-handle').last();
  const [sourceBeforeBox, sourceHandleBox, targetHandleBox] = await Promise.all([
    source.boundingBox(),
    sourceHandle.boundingBox(),
    targetHandle.boundingBox(),
  ]);
  expect(sourceBeforeBox).not.toBeNull();
  expect(sourceHandleBox).not.toBeNull();
  expect(targetHandleBox).not.toBeNull();
  const start = {
    x: sourceHandleBox!.x + sourceHandleBox!.width / 2,
    y: sourceHandleBox!.y + sourceHandleBox!.height / 2,
  };
  const end = { x: start.x + 36, y: targetHandleBox!.y + targetHandleBox!.height / 2 };
  const session = await context.newCDPSession(page);

  await session.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ ...start, id: 71 }],
  });
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ ...end, id: 71 }],
  });
  const dragging = page
    .locator('.workspace-row-shell[data-dnd-dragging="true"]:not([data-dnd-placeholder])')
    .filter({ has: page.locator(`[data-workspace-id="${initial[0]}"]`) });
  await expect(dragging).toBeVisible();
  const draggingBox = await dragging.boundingBox();
  expect(draggingBox).not.toBeNull();
  expect(draggingBox!.x).toBeCloseTo(sourceBeforeBox!.x, 0);

  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect.poll(order).toEqual([initial[1], initial[2], initial[0]]);
});
