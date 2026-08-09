import assert from 'node:assert/strict';
import test from 'node:test';
import {
	parseTerminalColorReports,
	terminalColorReport,
	terminalThemeColor
} from '../src/lib/terminal/color-report.ts';

test('parses xterm default color reports without forwarding them as keyboard input', () => {
	assert.deepEqual(
		parseTerminalColorReports('\u001b]10;rgb:2c2c/2525/2727\u001b\\\u001b]11;rgb:fbfb/fafa/fafa\u0007'),
		[
			{ slot: 10, color: '#2c2527' },
			{ slot: 11, color: '#fbfafa' }
		]
	);
	assert.equal(parseTerminalColorReports('\u001b]11;rgb:fbfb/fafa/fafa\u001b\\typed text'), undefined);
	assert.equal(parseTerminalColorReports('\u001b]13;rgb:fbfb/fafa/fafa\u001b\\'), undefined);
});

test('encodes app theme colors as xterm reports for tmux', () => {
	assert.equal(
		terminalColorReport(11, '#fbfafa'),
		'\u001b]11;rgb:fbfb/fafa/fafa\u001b\\'
	);
	assert.throws(() => terminalColorReport(11, 'white'), /terminal color/);
});

test('uses the current app theme when xterm briefly reports its previous palette', () => {
	const theme = {
		foreground: '#2c2527',
		background: '#fbfafa',
		cursor: '#c83f4e'
	};
	assert.equal(terminalThemeColor(10, theme, '#d8d2d4'), '#2c2527');
	assert.equal(terminalThemeColor(11, theme, '#141213'), '#fbfafa');
	assert.equal(terminalThemeColor(12, theme, '#e45b67'), '#c83f4e');
	assert.equal(terminalThemeColor(11, { background: 'invalid' }, '#141213'), '#141213');
});
