export type TerminalColorSlot = 10 | 11 | 12;

export interface TerminalColorReport {
	slot: TerminalColorSlot;
	color: string;
}

interface TerminalThemeColors {
	foreground?: string;
	background?: string;
	cursor?: string;
}

const TERMINAL_RGB_COLOR = /^#[0-9a-f]{6}$/i;
const XTERM_COLOR_REPORT = /\u001b\](10|11|12);rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})(?:\u001b\\|\u0007)/gi;

export function isTerminalColorSlot(value: unknown): value is TerminalColorSlot {
	return value === 10 || value === 11 || value === 12;
}

export function isTerminalRgbColor(value: unknown): value is string {
	return typeof value === 'string' && TERMINAL_RGB_COLOR.test(value);
}

function componentToByte(component: string): number {
	const maximum = 16 ** component.length - 1;
	return Math.round(Number.parseInt(component, 16) * 255 / maximum);
}

function rgbColor(red: string, green: string, blue: string): string {
	return `#${[red, green, blue]
		.map((component) => componentToByte(component).toString(16).padStart(2, '0'))
		.join('')}`;
}

export function parseTerminalColorReports(data: string): TerminalColorReport[] | undefined {
	const reports: TerminalColorReport[] = [];
	let offset = 0;
	for (const match of data.matchAll(XTERM_COLOR_REPORT)) {
		if (match.index !== offset) return undefined;
		const slot = Number(match[1]);
		if (!isTerminalColorSlot(slot)) return undefined;
		reports.push({ slot, color: rgbColor(match[2], match[3], match[4]) });
		offset = match.index + match[0].length;
	}
	return reports.length > 0 && offset === data.length ? reports : undefined;
}

export function terminalThemeColor(
	slot: TerminalColorSlot,
	theme: TerminalThemeColors,
	reportedColor: string
): string {
	const themeColor = slot === 10
		? theme.foreground
		: slot === 11
			? theme.background
			: theme.cursor;
	return isTerminalRgbColor(themeColor) ? themeColor : reportedColor;
}

export function terminalColorReport(slot: TerminalColorSlot, color: string): string {
	if (!isTerminalColorSlot(slot)) throw new TypeError('Invalid terminal color slot.');
	if (!isTerminalRgbColor(color)) throw new TypeError('Invalid terminal color.');
	const [red, green, blue] = color.slice(1).toLowerCase().match(/.{2}/g) ?? [];
	return `\u001b]${slot};rgb:${red}${red}/${green}${green}/${blue}${blue}\u001b\\`;
}
