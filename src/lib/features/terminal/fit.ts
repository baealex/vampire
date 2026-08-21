import { TERMINAL_SIZE_LIMITS } from '~/lib/shared/contracts/terminal-protocol.ts';

export interface TerminalFitDimensions {
  cols: number;
  rows: number;
}

export interface TerminalFitAddon {
  proposeDimensions: () => TerminalFitDimensions | undefined;
  fit: () => void;
}

export interface TerminalSize {
  columns: number;
  rows: number;
}

export type TerminalResize = (columns: number, rows: number) => void;

export function terminalSizeForVisibleArea(fitAddon: TerminalFitAddon): TerminalSize | undefined {
  const dimensions = fitAddon.proposeDimensions();
  if (
    !dimensions ||
    !Number.isFinite(dimensions.cols) ||
    !Number.isFinite(dimensions.rows) ||
    dimensions.cols < TERMINAL_SIZE_LIMITS.minimumColumns ||
    dimensions.rows < TERMINAL_SIZE_LIMITS.minimumRows
  )
    return undefined;
  return {
    columns: Math.min(dimensions.cols, TERMINAL_SIZE_LIMITS.maximumColumns),
    rows: Math.min(dimensions.rows, TERMINAL_SIZE_LIMITS.maximumRows),
  };
}

export function fitTerminalToVisibleArea(
  fitAddon: TerminalFitAddon,
  resize?: TerminalResize
): TerminalSize | undefined {
  const dimensions = terminalSizeForVisibleArea(fitAddon);
  if (!dimensions) return undefined;
  const proposed = fitAddon.proposeDimensions();
  if (proposed && proposed.cols === dimensions.columns && proposed.rows === dimensions.rows) fitAddon.fit();
  else resize?.(dimensions.columns, dimensions.rows);
  return dimensions;
}
