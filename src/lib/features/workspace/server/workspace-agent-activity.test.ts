import assert from 'node:assert/strict';
import test from 'node:test';
import { inferAgentState } from '~/lib/features/workspace/server/workspace-agent-activity.server.ts';

const foregroundCommand = { kind: 'command' as const, label: 'project-runner' };

test('keeps an agent working while its interrupt status is visible', () => {
  assert.equal(
    inferAgentState(
      foregroundCommand,
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
      foregroundCommand,
      `
The change is complete.

─ Worked for 1m 12s ─────────

› Explain this codebase
`
    ),
    'waiting'
  );
});

test('infers display state for an arbitrary foreground command', () => {
  assert.equal(inferAgentState({ kind: 'command', label: 'node' }, '> '), 'waiting');
  assert.equal(inferAgentState({ kind: 'shell', label: 'zsh' }, '> '), null);
});
