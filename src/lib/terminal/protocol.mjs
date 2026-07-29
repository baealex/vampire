/**
 * @typedef {{ type: 'activate' } | { type: 'snapshot-ready' } | { type: 'input'; data: string } | { type: 'resize'; columns: number; rows: number }} TerminalClientMessage
 * @typedef {{ type: 'snapshot'; data: string } | { type: 'screen-ready' } | { type: 'output'; data: string; activity: boolean; activityAt: number | null } | { type: 'repository-status'; changeCount: number; worktreeCount: number } | { type: 'error'; message: string }} TerminalServerMessage
 */

export const TERMINAL_SIZE_LIMITS = {
	minimumColumns: 20,
	maximumColumns: 240,
	minimumRows: 5,
	maximumRows: 120
};

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** @param {unknown} value @param {number} minimum @param {number} maximum */
function isIntegerBetween(value, minimum, maximum) {
	return Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

/** @param {unknown} value @returns {TerminalClientMessage | undefined} */
export function parseTerminalClientMessage(value) {
	if (!isRecord(value)) return undefined;
	if (value.type === 'activate' || value.type === 'snapshot-ready') return { type: value.type };
	if (value.type === 'input' && typeof value.data === 'string') return { type: 'input', data: value.data };
	if (
		value.type === 'resize'
		&& isIntegerBetween(value.columns, TERMINAL_SIZE_LIMITS.minimumColumns, TERMINAL_SIZE_LIMITS.maximumColumns)
		&& isIntegerBetween(value.rows, TERMINAL_SIZE_LIMITS.minimumRows, TERMINAL_SIZE_LIMITS.maximumRows)
	) {
		return { type: 'resize', columns: Number(value.columns), rows: Number(value.rows) };
	}
	return undefined;
}

/** @param {unknown} value @returns {TerminalServerMessage | undefined} */
export function parseTerminalServerMessage(value) {
	if (!isRecord(value)) return undefined;
	if (value.type === 'snapshot' && typeof value.data === 'string') return { type: 'snapshot', data: value.data };
	if (value.type === 'screen-ready') return { type: 'screen-ready' };
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

/** @param {unknown} raw @param {(value: unknown) => unknown} parser */
function decodeJsonMessage(raw, parser) {
	try {
		return parser(JSON.parse(typeof raw === 'string' ? raw : String(raw)));
	} catch {
		return undefined;
	}
}

/** @param {unknown} raw @returns {TerminalClientMessage | undefined} */
export function decodeTerminalClientMessage(raw) {
	return /** @type {TerminalClientMessage | undefined} */ (decodeJsonMessage(raw, parseTerminalClientMessage));
}

/** @param {unknown} raw @returns {TerminalServerMessage | undefined} */
export function decodeTerminalServerMessage(raw) {
	return /** @type {TerminalServerMessage | undefined} */ (decodeJsonMessage(raw, parseTerminalServerMessage));
}

/** @param {TerminalClientMessage} message */
export function encodeTerminalClientMessage(message) {
	const parsed = parseTerminalClientMessage(message);
	if (!parsed) throw new TypeError('Invalid terminal client message.');
	return JSON.stringify(parsed);
}

/** @param {TerminalServerMessage} message */
export function encodeTerminalServerMessage(message) {
	const parsed = parseTerminalServerMessage(message);
	if (!parsed) throw new TypeError('Invalid terminal server message.');
	return JSON.stringify(parsed);
}
