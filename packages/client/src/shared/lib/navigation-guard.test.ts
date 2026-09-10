import { afterEach, expect, test, vi } from 'vitest';
import { navigationGuard, registerNavigationGuard } from './navigation-guard.ts';

afterEach(() => {
  registerNavigationGuard(undefined);
});

test('registers and releases the current navigation guard', async () => {
  const guard = vi.fn(async () => true);
  const release = registerNavigationGuard(guard);
  expect(navigationGuard()).toBe(guard);
  await expect(navigationGuard()?.()).resolves.toBe(true);
  release();
  expect(navigationGuard()).toBeUndefined();
});

test('an older cleanup cannot remove a newer guard', () => {
  const releaseOld = registerNavigationGuard(async () => true);
  const current = async () => false;
  registerNavigationGuard(current);
  releaseOld();
  expect(navigationGuard()).toBe(current);
});
