export const COMPACT_RESIZE_INITIAL_CADENCE_MS = 1000 / 60;
export const COMPACT_RESIZE_MIN_SETTLE_MS = 64;
export const COMPACT_RESIZE_MAX_SETTLE_MS = 80;
export const COMPACT_RESIZE_CADENCE_MULTIPLIER = 3;

export function nextTerminalResizeCadence(previousCadence: number, interval: number): number {
  // Ignore the initial sample and long idle gaps. During an animation, an EMA
  // prevents one irregular frame from inflating the interaction latency budget.
  if (interval < 4 || interval > 100) return previousCadence;
  return previousCadence * 0.5 + interval * 0.5;
}

export function compactTerminalResizeSettleDelay(cadence: number): number {
  return Math.min(
    COMPACT_RESIZE_MAX_SETTLE_MS,
    Math.max(COMPACT_RESIZE_MIN_SETTLE_MS, cadence * COMPACT_RESIZE_CADENCE_MULTIPLIER)
  );
}
