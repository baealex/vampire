import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeTmuxControlValue, parseTmuxControlOutput } from './terminal.mjs';

test('decodes tmux control mode octal escapes into terminal bytes', () => {
	assert.equal(decodeTmuxControlValue('hello\\015\\012next'), 'hello\r\nnext');
});

test('decodes UTF-8 bytes split across tmux output records', () => {
	const decoder = new TextDecoder();
	const outputRecord = (...bytes) => Buffer.concat([Buffer.from('%output %7 '), Buffer.from(bytes)]);
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
