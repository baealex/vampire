import assert from 'node:assert/strict';
import test from 'node:test';
import { inferAgentState, isAgentProcessLabel } from '~/lib/features/workspace/server/workspace-agent-activity.ts';

const codex = { kind: 'command' as const, label: 'codex' };

test('recognizes supported terminal agent process labels', () => {
  assert.equal(isAgentProcessLabel('codex'), true);
  assert.equal(isAgentProcessLabel('Claude'), true);
  assert.equal(isAgentProcessLabel('node'), false);
});

test('keeps an agent working while its interrupt status is visible', () => {
  assert.equal(
    inferAgentState(
      codex,
      `
• Ran pnpm check

◦ Working (25s • esc to interrupt)

› Explain this codebase
`
    ),
    'working'
  );
});

test('marks an agent waiting only after its working status has cleared', () => {
  assert.equal(
    inferAgentState(
      codex,
      `
The change is complete.

─ Worked for 1m 12s ─────────

› Explain this codebase
`
    ),
    'waiting'
  );
});

test('recognizes a fresh Codex prompt above unused pane rows', () => {
  const unusedRows = Array.from({ length: 40 }, () => '');
  const freshCodexScreen = [
    '>_ OpenAI Codex',
    '',
    '› Ask Codex to do anything',
    '',
    'gpt-5.6-sol · max · Context 100% left',
    ...unusedRows,
  ].join('\n');

  assert.equal(inferAgentState(codex, freshCodexScreen), 'waiting');
});

test('does not inspect arbitrary foreground commands as agents', () => {
  assert.equal(inferAgentState({ kind: 'command', label: 'node' }, 'esc to interrupt\n> '), null);
});
