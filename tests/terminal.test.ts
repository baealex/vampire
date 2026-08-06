import assert from 'node:assert/strict';
import test from 'node:test';
import {
	decodeTmuxControlValue,
	isTerminalOutputActivity,
	parseTmuxControlOutput,
	terminalInputControlCommands,
	terminalSubmissionData,
	terminalSubmissionSettleMs,
	terminalSnapshotHistoryLines
} from '../runtime/terminal.ts';

test('bounds terminal snapshots to the retained client history', () => {
	assert.equal(terminalSnapshotHistoryLines(), 10_000);
	assert.equal(terminalSnapshotHistoryLines(4_000), 4_000);
	assert.equal(terminalSnapshotHistoryLines(50_000), 10_000);
	assert.equal(terminalSnapshotHistoryLines(-1), 10_000);
	assert.equal(terminalSnapshotHistoryLines(Number.NaN), 10_000);
});

test('encodes terminal input as bounded UTF-8 tmux control commands', () => {
	assert.deepEqual(
		Array.from(terminalInputControlCommands('%7', 'A한\r')),
		['send-keys -H -t %7 41 ed 95 9c 0d']
	);
	assert.deepEqual(Array.from(terminalInputControlCommands('%7', '')), []);

	const input = `${'a'.repeat(4_096)}한`;
	const commands = Array.from(terminalInputControlCommands('%7', input));
	assert.equal(commands.length, 2);
	const bytes = commands.flatMap((command) => command.split(' ').slice(4).map((byte) => Number.parseInt(byte, 16)));
	assert.equal(Buffer.from(bytes).toString(), input);
	assert.throws(() => Array.from(terminalInputControlCommands('not-a-pane', 'hello')), /pane identifier/);
});

test('prepares composer text as a completed bracketed paste before submit', () => {
	assert.equal(
		terminalSubmissionData('first\r\nsecond\nthird', true),
		'\u001b[200~first\rsecond\rthird\u001b[201~'
	);
	assert.equal(terminalSubmissionData('first\nsecond', false), 'first\rsecond');
	assert.equal(terminalSubmissionSettleMs(true), 20);
	assert.equal(terminalSubmissionSettleMs(false), 140);
});

test('decodes tmux control mode octal escapes into terminal bytes', () => {
	assert.equal(decodeTmuxControlValue('hello\\015\\012next'), 'hello\r\nnext');
});

test('decodes UTF-8 bytes split across tmux output records', () => {
	const decoder = new TextDecoder();
	const outputRecord = (...bytes: number[]) => Buffer.concat([Buffer.from('%output %7 '), Buffer.from(bytes)]);
	assert.equal(parseTmuxControlOutput(outputRecord(0xed), '%7', decoder), '');
	assert.equal(parseTmuxControlOutput(outputRecord(0x95), '%7', decoder), '');
	assert.equal(parseTmuxControlOutput(outputRecord(0x9c), '%7', decoder), '한');
	assert.equal(parseTmuxControlOutput(outputRecord(0xe2, 0x94, 0x80), '%7', decoder), '─');
});

test('reads output only for the attached pane', () => {
	assert.equal(parseTmuxControlOutput('%output %7 hello\\015\\012', '%7'), 'hello\r\n');
	assert.equal(parseTmuxControlOutput('%output %8 ignored', '%7'), undefined);
	assert.equal(parseTmuxControlOutput('%begin 1 2 3', '%7'), undefined);
});

test('treats redraw output suppressed by another device as synthetic', () => {
	const state = {
		snapshotAcknowledged: true,
		syntheticOutputDepth: 0,
		syntheticOutputUntil: 1_000
	};
	assert.equal(isTerminalOutputActivity({ ...state, sharedOutputAllowed: true }, 1_001), true);
	assert.equal(isTerminalOutputActivity({ ...state, sharedOutputAllowed: false }, 1_001), false);
	assert.equal(isTerminalOutputActivity({ ...state, sharedOutputAllowed: true }, 999), false);
});
