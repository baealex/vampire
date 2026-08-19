import { isTerminalColorSlot, isTerminalRgbColor, type TerminalColorSlot } from './color-report.ts';

export interface TerminalHistoryState {
	loaded: number;
	available: number;
}

export type TerminalClientMessage =
	| { type: 'activate' }
	| { type: 'snapshot-ready' }
	| { type: 'load-history'; lines: number }
	| { type: 'input'; data: string }
	| { type: 'submit'; data: string; bracketedPaste: boolean }
	| { type: 'terminal-color'; slot: TerminalColorSlot; color: string }
	| { type: 'resize'; columns: number; rows: number };

export type TerminalServerMessage =
	| { type: 'snapshot'; data: string; history?: TerminalHistoryState }
	| { type: 'geometry'; columns: number; rows: number; active?: boolean }
	| { type: 'request-terminal-theme' }
	| { type: 'screen-ready' }
	| { type: 'output'; data: string; activity: boolean; activityAt: number | null }
	| { type: 'repository-status'; changeCount: number; worktreeCount: number }
	| { type: 'error'; message: string };

export const TERMINAL_PROTOCOL_VERSION = 2;

export const TERMINAL_SIZE_LIMITS = {
	minimumColumns: 20,
	maximumColumns: 512,
	minimumRows: 5,
	maximumRows: 256
};

export const TERMINAL_GEOMETRY_LIMITS = {
	minimumColumns: 1,
	maximumColumns: 1_000,
	minimumRows: 1,
	maximumRows: 500
};

export const TERMINAL_SCROLLBACK_LINES = {
	reduced: 4_000,
	standard: 10_000
} as const;

export const TERMINAL_HISTORY_CHUNK_LINES = {
	reduced: 250,
	standard: 500
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isIntegerBetween(value: unknown, minimum: number, maximum: number): boolean {
	return Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

export function parseTerminalClientMessage(value: unknown): TerminalClientMessage | undefined {
	if (!isRecord(value)) return undefined;
	if (value.type === 'activate' || value.type === 'snapshot-ready') return { type: value.type };
	if (
		value.type === 'load-history'
		&& isIntegerBetween(value.lines, 1, TERMINAL_SCROLLBACK_LINES.standard)
	) return { type: 'load-history', lines: Number(value.lines) };
	if (value.type === 'input' && typeof value.data === 'string') return { type: 'input', data: value.data };
	if (
		value.type === 'terminal-color'
		&& isTerminalColorSlot(value.slot)
		&& isTerminalRgbColor(value.color)
	) {
		return { type: 'terminal-color', slot: value.slot, color: value.color };
	}
	if (
		value.type === 'submit'
		&& typeof value.data === 'string'
		&& typeof value.bracketedPaste === 'boolean'
	) {
		return { type: 'submit', data: value.data, bracketedPaste: value.bracketedPaste };
	}
	if (
		value.type === 'resize'
		&& isIntegerBetween(value.columns, TERMINAL_SIZE_LIMITS.minimumColumns, TERMINAL_SIZE_LIMITS.maximumColumns)
		&& isIntegerBetween(value.rows, TERMINAL_SIZE_LIMITS.minimumRows, TERMINAL_SIZE_LIMITS.maximumRows)
	) {
		return { type: 'resize', columns: Number(value.columns), rows: Number(value.rows) };
	}
	return undefined;
}

export function parseTerminalServerMessage(value: unknown): TerminalServerMessage | undefined {
	if (!isRecord(value)) return undefined;
	if (value.type === 'snapshot' && typeof value.data === 'string') {
		if (value.history === undefined) return { type: 'snapshot', data: value.data };
		if (
			!isRecord(value.history)
			|| !isIntegerBetween(value.history.loaded, 0, TERMINAL_SCROLLBACK_LINES.standard)
			|| !isIntegerBetween(value.history.available, 0, TERMINAL_SCROLLBACK_LINES.standard)
			|| Number(value.history.loaded) > Number(value.history.available)
		) return undefined;
		return {
			type: 'snapshot',
			data: value.data,
			history: {
				loaded: Number(value.history.loaded),
				available: Number(value.history.available)
			}
		};
	}
	if (
		value.type === 'geometry'
		&& isIntegerBetween(value.columns, TERMINAL_GEOMETRY_LIMITS.minimumColumns, TERMINAL_GEOMETRY_LIMITS.maximumColumns)
		&& isIntegerBetween(value.rows, TERMINAL_GEOMETRY_LIMITS.minimumRows, TERMINAL_GEOMETRY_LIMITS.maximumRows)
		&& (value.active === undefined || typeof value.active === 'boolean')
	) {
		const geometry = { type: 'geometry' as const, columns: Number(value.columns), rows: Number(value.rows) };
		return value.active === undefined ? geometry : { ...geometry, active: value.active };
	}
	if (value.type === 'request-terminal-theme' || value.type === 'screen-ready') return { type: value.type };
	if (
		value.type === 'output'
		&& typeof value.data === 'string'
		&& typeof value.activity === 'boolean'
		&& (
			(value.activity && typeof value.activityAt === 'number' && Number.isFinite(value.activityAt))
			|| (!value.activity && value.activityAt === null)
		)
	) {
		return { type: 'output', data: value.data, activity: value.activity, activityAt: value.activityAt };
	}
	if (
		value.type === 'repository-status'
		&& Number.isInteger(value.changeCount)
		&& Number(value.changeCount) >= 0
		&& Number.isInteger(value.worktreeCount)
		&& Number(value.worktreeCount) >= 0
	) {
		return {
			type: 'repository-status',
			changeCount: Number(value.changeCount),
			worktreeCount: Number(value.worktreeCount)
		};
	}
	if (value.type === 'error' && typeof value.message === 'string') return { type: 'error', message: value.message };
	return undefined;
}

function decodeJsonMessage<T>(raw: unknown, parser: (value: unknown) => T | undefined): T | undefined {
	try {
		return parser(JSON.parse(typeof raw === 'string' ? raw : String(raw)));
	} catch {
		return undefined;
	}
}

export function decodeTerminalClientMessage(raw: unknown): TerminalClientMessage | undefined {
	return decodeJsonMessage(raw, parseTerminalClientMessage);
}

export function decodeTerminalServerMessage(raw: unknown): TerminalServerMessage | undefined {
	return decodeJsonMessage(raw, parseTerminalServerMessage);
}

export function encodeTerminalClientMessage(message: TerminalClientMessage): string {
	const parsed = parseTerminalClientMessage(message);
	if (!parsed) throw new TypeError('Invalid terminal client message.');
	return JSON.stringify(parsed);
}

export function encodeTerminalServerMessage(message: TerminalServerMessage): string {
	const parsed = parseTerminalServerMessage(message);
	if (!parsed) throw new TypeError('Invalid terminal server message.');
	return JSON.stringify(parsed);
}
