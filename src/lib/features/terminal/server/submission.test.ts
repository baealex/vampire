import assert from 'node:assert/strict';
import test from 'node:test';

import { TERMINAL_SUBMISSION_FAILURE_MESSAGE_MAX_LENGTH } from '~/lib/shared/contracts/terminal-protocol.ts';
import {
  executeTerminalSubmission,
  TerminalSubmissionLedger,
  terminalSubmissionFailureMessage,
} from './submission.server.ts';

test('completes a submission only after paste, settle, and Enter finish', async () => {
  const events: string[] = [];
  const completed = await executeTerminalSubmission('first\nsecond', true, {
    inputAllowed: () => true,
    sendInput: async (data) => {
      events.push(`input:${data}`);
    },
    wait: async (durationMs) => {
      events.push(`wait:${durationMs}`);
    },
    sendEnter: async () => {
      events.push('enter');
    },
  });

  assert.equal(completed, true);
  assert.deepEqual(events, ['input:\u001b[200~first\rsecond\u001b[201~', 'wait:20', 'enter']);
});

test('leaves an interrupted submission unconfirmed and propagates operation failures', async () => {
  let allowed = true;
  const events: string[] = [];
  const interrupted = await executeTerminalSubmission('draft', false, {
    inputAllowed: () => allowed,
    sendInput: async () => {
      events.push('input');
    },
    wait: async () => {
      allowed = false;
      events.push('wait');
    },
    sendEnter: async () => {
      events.push('enter');
    },
  });
  assert.equal(interrupted, false);
  assert.deepEqual(events, ['input', 'wait']);

  await assert.rejects(
    executeTerminalSubmission('draft', false, {
      inputAllowed: () => true,
      sendInput: async () => undefined,
      wait: async () => undefined,
      sendEnter: async () => {
        throw new Error('Enter failed');
      },
    }),
    /Enter failed/
  );
});

test('deduplicates pending and settled request IDs within a bounded ledger', () => {
  const ledger = new TerminalSubmissionLedger(2);
  assert.deepEqual(ledger.register('request-1'), { state: 'started' });
  assert.deepEqual(ledger.register('request-1'), { state: 'pending' });
  assert.deepEqual(ledger.register('request-2'), { state: 'started' });
  assert.deepEqual(ledger.register('request-3'), { state: 'full' });

  const completed = { type: 'submission-result', requestId: 'request-1', status: 'completed' } as const;
  assert.equal(ledger.settle(completed), true);
  assert.equal(
    ledger.settle({ type: 'submission-result', requestId: 'request-1', status: 'failed', message: 'late failure' }),
    false
  );
  assert.deepEqual(ledger.register('request-1'), { state: 'settled', result: completed });

  assert.deepEqual(ledger.register('request-3'), { state: 'started' });
  assert.equal(ledger.size, 2);
  assert.deepEqual(ledger.register('request-2'), { state: 'pending' });
  assert.equal(ledger.settle({ type: 'submission-result', requestId: 'unknown', status: 'completed' }), false);
});

test('bounds terminal submission failure details for the wire protocol', () => {
  assert.equal(terminalSubmissionFailureMessage(undefined), 'Terminal submission failed.');
  assert.equal(terminalSubmissionFailureMessage(new Error('  tmux failed  ')), 'tmux failed');
  assert.equal(
    terminalSubmissionFailureMessage(new Error('x'.repeat(TERMINAL_SUBMISSION_FAILURE_MESSAGE_MAX_LENGTH + 20))).length,
    TERMINAL_SUBMISSION_FAILURE_MESSAGE_MAX_LENGTH
  );
});
