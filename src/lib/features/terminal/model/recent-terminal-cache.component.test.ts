import { afterEach, expect, test, vi } from 'vitest';
import { RecentTerminalCache } from './recent-terminal-cache.ts';

function terminal() {
  return { canSuspend: true, suspend: vi.fn(), dispose: vi.fn() };
}

afterEach(() => vi.useRealTimers());

test('quick workspace return reuses a terminal and cancels its expiry', () => {
  vi.useFakeTimers();
  const cache = new RecentTerminalCache<ReturnType<typeof terminal>>();
  const first = terminal();
  cache.release('a', first);
  expect(first.suspend).toHaveBeenCalledOnce();
  expect(cache.take('a')).toBe(first);
  vi.advanceTimersByTime(31_000);
  expect(first.dispose).not.toHaveBeenCalled();
});

test('evicts the oldest idle terminal and expires the rest', () => {
  vi.useFakeTimers();
  const cache = new RecentTerminalCache<ReturnType<typeof terminal>>(2, 1_000);
  const values = [terminal(), terminal(), terminal()];
  values.forEach((value, index) => cache.release(String(index), value));
  expect(values[0].dispose).toHaveBeenCalledOnce();
  expect(cache.take('0')).toBeUndefined();
  vi.advanceTimersByTime(1_000);
  expect(values[1].dispose).toHaveBeenCalledOnce();
  expect(values[2].dispose).toHaveBeenCalledOnce();
});

test('never reuses a terminal which became unavailable while idle', () => {
  vi.useFakeTimers();
  const cache = new RecentTerminalCache<ReturnType<typeof terminal>>();
  const value = terminal();
  cache.release('a', value);
  value.canSuspend = false;
  expect(cache.take('a')).toBeUndefined();
  expect(value.dispose).toHaveBeenCalledOnce();
});
