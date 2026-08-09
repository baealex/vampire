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

export function terminalSizeForVisibleArea(fitAddon: TerminalFitAddon): TerminalSize | undefined {
	const dimensions = fitAddon.proposeDimensions();
	if (
		!dimensions
		|| !Number.isFinite(dimensions.cols)
		|| !Number.isFinite(dimensions.rows)
		|| dimensions.cols < 20
		|| dimensions.rows < 5
	) return undefined;
	return { columns: dimensions.cols, rows: dimensions.rows };
}

export function fitTerminalToVisibleArea(fitAddon: TerminalFitAddon): TerminalSize | undefined {
	const dimensions = terminalSizeForVisibleArea(fitAddon);
	if (!dimensions) return undefined;
	fitAddon.fit();
	return dimensions;
}
