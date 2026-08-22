import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeTmuxControlValue,
  isTerminalOutputActivity,
  parseTmuxControlOutput,
  terminalAlternateScreenExitState,
  terminalColorControlCommand,
  terminalActivityTimestamp,
  terminalAvailableHistoryLines,
  terminalInputControlCommands,
  terminalPaneState,
  terminalScreenData,
  terminalSubmissionData,
  terminalSubmissionSettleMs,
  terminalSnapshotData,
  terminalSnapshotHistoryLines,
  tmuxSupportsTerminalColorReports,
} from '~/lib/features/terminal/server/terminal.ts';

test('converts an exact tmux activity watermark without inventing a future window', () => {
  assert.equal(terminalActivityTimestamp('1786280522\n'), 1_786_280_522_000);
  assert.equal(terminalActivityTimestamp('0\n'), undefined);
  assert.equal(terminalActivityTimestamp('1786280522 extra\n'), undefined);
  assert.equal(terminalActivityTimestamp('not-a-timestamp'), undefined);
});

test('reports browser terminal colors through the tmux control client', () => {
  assert.equal(
    terminalColorControlCommand('%7', 11, '#fbfafa'),
    "refresh-client -r '%7:\u001b]11;rgb:fbfb/fafa/fafa\u001b\\'"
  );
  assert.throws(() => terminalColorControlCommand('not-a-pane', 11, '#fbfafa'), /pane identifier/);
  assert.throws(() => terminalColorControlCommand('%7', 11, "#fff'; kill-server"), /terminal color/);
});

test('detects tmux terminal color report support from available commands', () => {
  assert.equal(
    tmuxSupportsTerminalColorReports(
      'refresh-client (refresh) [-cDlLRSU] [-C XxY] [-r pane:report] [-t target-client]\n'
    ),
    true
  );
  assert.equal(
    tmuxSupportsTerminalColorReports('refresh-client (refresh) [-cDlLRSU] [-C XxY] [-t target-client]\n'),
    false
  );
  assert.equal(tmuxSupportsTerminalColorReports('run-shell (run) [-bdC] [-t target-pane] shell-command\n'), false);
});

test('bounds terminal snapshots to the retained client history', () => {
  assert.equal(terminalSnapshotHistoryLines(), 10_000);
  assert.equal(terminalSnapshotHistoryLines(4_000), 4_000);
  assert.equal(terminalSnapshotHistoryLines(50_000), 10_000);
  assert.equal(terminalSnapshotHistoryLines(-1), 10_000);
  assert.equal(terminalSnapshotHistoryLines(Number.NaN), 10_000);
});

test('parses available tmux history within the client retention limit', () => {
  assert.equal(terminalAvailableHistoryLines('750\n', 4_000), 750);
  assert.equal(terminalAvailableHistoryLines('12000\n', 10_000), 10_000);
  assert.equal(terminalAvailableHistoryLines('invalid\n', 10_000), 0);
  assert.equal(terminalAvailableHistoryLines('-1\n', 10_000), 0);
});

test('removes only the control record separator from a terminal snapshot', () => {
  assert.equal(terminalSnapshotData('first row\nlast row\n'), 'first row\nlast row');
  assert.equal(terminalSnapshotData('first row\n\n'), 'first row\n');
  assert.equal(terminalSnapshotData('single row'), 'single row');
  assert.equal(terminalSnapshotData(''), '');
});

test('detects an alternate-screen exit split across tmux output records once', () => {
  const first = terminalAlternateScreenExitState('', 'before\u001b[?104');
  assert.equal(first.exited, false);
  const second = terminalAlternateScreenExitState(first.tail, '9lafter');
  assert.equal(second.exited, true);
  const third = terminalAlternateScreenExitState(second.tail, 'plain output');
  assert.equal(third.exited, false);
  const short = terminalAlternateScreenExitState('', 'before\u001b[?47l');
  assert.equal(short.exited, true);
  assert.equal(terminalAlternateScreenExitState(short.tail, 'plain output').exited, false);
  assert.equal(terminalAlternateScreenExitState('', '\\u001b[?1049l').exited, false);
});

test('parses the terminal modes required to continue a captured pane', () => {
  const state = terminalPaneState('1\t3\t2\t1\t1\t17\t4\t0\t1\t0\t0\t1\t0\t23\n', { columns: 80, rows: 24 });
  assert.deepEqual(state, {
    alternateScreen: true,
    alternateSavedCursor: { column: 3, row: 2 },
    bracketedPaste: true,
    cursor: { column: 17, row: 4 },
    cursorWrapPending: false,
    cursorVisible: true,
    insertMode: false,
    keypadApplicationMode: false,
    keypadCursorMode: true,
    originMode: false,
    scrollRegion: { top: 0, bottom: 23 },
    wraparoundMode: true,
  });
  assert.equal(terminalPaneState('1\tinvalid\n', { columns: 80, rows: 24 }), undefined);
});

test('crops a saved main-screen cursor when a TUI outlives a pane shrink', () => {
  const state = terminalPaneState('1\t90\t36\t0\t1\t6\t11\t0\t0\t0\t0\t1\t0\t22\n', { columns: 63, rows: 23 });
  assert.ok(state);
  assert.deepEqual(state.alternateSavedCursor, { column: 62, row: 22 });
});

test('ignores tmux alternate-screen cursor sentinels while on the main screen', () => {
  const state = terminalPaneState('0\t4294967295\t4294967295\t0\t1\t17\t4\t0\t0\t0\t0\t1\t0\t23\n', {
    columns: 80,
    rows: 24,
  });
  assert.ok(state);
  assert.deepEqual(state.cursor, { column: 17, row: 4 });
});

test('restores the cursor on tmux versions without bracketed-paste state', () => {
  const state = terminalPaneState('0\t4294967295\t4294967295\t\t1\t17\t4\t0\t0\t0\t0\t1\t0\t23\n', {
    columns: 80,
    rows: 24,
  });
  assert.ok(state);
  assert.equal(state.bracketedPaste, undefined);
  assert.deepEqual(state.cursor, { column: 17, row: 4 });
  assert.doesNotMatch(terminalScreenData('screen\n', state), /\?2004[hl]/);
});

test('rebuilds a pending-autowrap cursor by rewriting its physical row', () => {
  const state = terminalPaneState('0\t4294967295\t4294967295\t0\t1\t5\t0\t0\t0\t0\t0\t1\t0\t1\n', {
    columns: 5,
    rows: 2,
  });
  assert.ok(state);
  assert.equal(state.cursorWrapPending, true);
  assert.deepEqual(state.cursor, { column: 4, row: 0 });
  const data = terminalScreenData('abcde\nnext\n', state, '', 'abcde\n     \n');
  assert.match(data, /\u001b\[1;1H\u001b\[0mabcde\u001b\[4l\u001b\[\?25h$/);
});

test('rebuilds the visible grid, terminal modes, and cursor without clearing scrollback', () => {
  const state = terminalPaneState('0\t0\t0\t0\t1\t3\t1\t0\t0\t0\t0\t1\t0\t23\n', { columns: 80, rows: 24 });
  assert.ok(state);
  assert.equal(
    terminalScreenData('first row\nlast row\n', state),
    '\u001b[?1049l\u001b[?6l\u001b[r\u001b[0m\u001b[4l\u001b[?7h\u001b[2J\u001b[Hfirst row\nlast row' +
      '\u001b[4l\u001b[?1l\u001b>\u001b[?2004l\u001b[?7h' +
      '\u001b[1;24r\u001b[?6l\u001b[2;4H\u001b[?25h'
  );
});

test('rebuilds the main screen behind an active alternate-screen TUI', () => {
  const state = terminalPaneState('1\t5\t6\t1\t1\t9\t10\t0\t1\t1\t0\t1\t0\t23\n', { columns: 80, rows: 24 });
  assert.ok(state);
  const data = terminalScreenData('alternate screen\n', state, 'saved main screen\n');
  assert.ok(data.indexOf('saved main screen') < data.indexOf('\u001b[?1049h'));
  assert.ok(data.indexOf('\u001b[?1049h') < data.indexOf('alternate screen'));
  assert.ok(data.endsWith('\u001b[11;10H\u001b[?25h'));
});

test('encodes terminal input as bounded UTF-8 tmux control commands', () => {
  assert.deepEqual(Array.from(terminalInputControlCommands('%7', 'A한\r')), ['send-keys -H -t %7 41 ed 95 9c 0d']);
  assert.deepEqual(Array.from(terminalInputControlCommands('%7', '')), []);

  const input = `${'a'.repeat(4_096)}한`;
  const commands = Array.from(terminalInputControlCommands('%7', input));
  assert.equal(commands.length, 2);
  const bytes = commands.flatMap((command) =>
    command
      .split(' ')
      .slice(4)
      .map((byte) => Number.parseInt(byte, 16))
  );
  assert.equal(Buffer.from(bytes).toString(), input);
  assert.throws(() => Array.from(terminalInputControlCommands('not-a-pane', 'hello')), /pane identifier/);
});

test('prepares composer text as a completed bracketed paste before submit', () => {
  assert.equal(terminalSubmissionData('first\r\nsecond\nthird', true), '\u001b[200~first\rsecond\rthird\u001b[201~');
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
    syntheticOutputUntil: 1_000,
  };
  assert.equal(isTerminalOutputActivity({ ...state, sharedOutputAllowed: true }, 1_001), true);
  assert.equal(isTerminalOutputActivity({ ...state, sharedOutputAllowed: false }, 1_001), false);
  assert.equal(isTerminalOutputActivity({ ...state, sharedOutputAllowed: true }, 999), false);
});
