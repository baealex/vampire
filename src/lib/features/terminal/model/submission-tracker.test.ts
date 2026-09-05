import assert from 'node:assert/strict';
import test from 'node:test';

import { TerminalSubmissionTracker } from './submission-tracker.ts';

test('tracks the original draft until a completed server result arrives', () => {
  const tracker = new TerminalSubmissionTracker({ now: () => 1_000 });

  assert.equal(tracker.track({ requestId: 'request-1', draft: 'Original draft' }), true);
  assert.deepEqual(tracker.entries, [
    {
      requestId: 'request-1',
      draft: 'Original draft',
      submittedAt: 1_000,
      status: 'pending',
      acknowledgementDeadlineAt: 31_000,
    },
  ]);
  assert.equal(
    tracker.applyResult({ type: 'submission-result', requestId: 'request-1', status: 'completed' }, 1_100),
    true
  );
  assert.deepEqual(tracker.entries, []);
});

test('retains failed submissions without claiming that no input reached the terminal', () => {
  const tracker = new TerminalSubmissionTracker({ now: () => 1_000 });
  tracker.track({ requestId: 'request-1', draft: 'Keep this text' });

  assert.equal(
    tracker.applyResult(
      {
        type: 'submission-result',
        requestId: 'request-1',
        status: 'failed',
        message: 'tmux command failed',
      },
      1_200
    ),
    true
  );
  assert.deepEqual(tracker.entries, [
    {
      requestId: 'request-1',
      draft: 'Keep this text',
      submittedAt: 1_000,
      status: 'failed',
      message: 'tmux command failed',
      updatedAt: 1_200,
      deliveryMayHaveOccurred: true,
    },
  ]);
  assert.equal(
    tracker.applyResult({ type: 'submission-result', requestId: 'unknown', status: 'completed' }, 1_300),
    false
  );
  assert.equal(
    tracker.applyResult({ type: 'submission-result', requestId: 'request-1', status: 'failed' }, 1_300),
    false
  );
});

test('marks one timed-out request or every disconnected request uncertain without resending', () => {
  const tracker = new TerminalSubmissionTracker({ now: () => 1_000 });
  tracker.track({ requestId: 'request-1', draft: 'First' });
  tracker.track({ requestId: 'request-2', draft: 'Second' });

  assert.equal(tracker.markUncertain('request-1', 'Timed out', 1_500), 1);
  assert.deepEqual(
    tracker.entries.map(({ requestId, status }) => ({ requestId, status })),
    [
      { requestId: 'request-2', status: 'pending' },
      { requestId: 'request-1', status: 'uncertain' },
    ]
  );
  assert.equal(tracker.markDisconnected(1_600), 1);
  assert.deepEqual(
    tracker.entries.map(({ requestId, status }) => ({ requestId, status })),
    [
      { requestId: 'request-1', status: 'uncertain' },
      { requestId: 'request-2', status: 'uncertain' },
    ]
  );

  assert.equal(
    tracker.applyResult({ type: 'submission-result', requestId: 'request-1', status: 'completed' }, 1_700),
    true
  );
  assert.deepEqual(
    tracker.entries.map((entry) => entry.requestId),
    ['request-2']
  );
});

test('expires only submissions whose acknowledgement deadline elapsed', () => {
  const tracker = new TerminalSubmissionTracker({ acknowledgementTimeoutMs: 100, now: () => 1_000 });
  tracker.track({ requestId: 'request-1', draft: 'First' }, 1_000);
  tracker.track({ requestId: 'request-2', draft: 'Second' }, 1_050);

  assert.equal(tracker.expire(1_099), 0);
  assert.equal(tracker.expire(1_100), 1);
  assert.deepEqual(
    tracker.entries.map(({ requestId, status }) => ({ requestId, status })),
    [
      { requestId: 'request-2', status: 'pending' },
      { requestId: 'request-1', status: 'uncertain' },
    ]
  );
});

test('restores persisted pending submissions as uncertain and ignores malformed entries', () => {
  const tracker = new TerminalSubmissionTracker({
    now: () => 5_000,
    initialEntries: [
      {
        requestId: 'pending-1',
        draft: 'Pending before reload',
        submittedAt: 1_000,
        status: 'pending',
        acknowledgementDeadlineAt: 31_000,
      },
      {
        requestId: 'failed-1',
        draft: 'Already failed',
        submittedAt: 2_000,
        status: 'failed',
        message: 'Known error',
        updatedAt: 2_100,
        deliveryMayHaveOccurred: true,
      },
      { requestId: 'bad id', draft: 'Invalid', submittedAt: 3_000, status: 'pending' },
    ],
  });

  assert.deepEqual(
    tracker.entries.map(({ requestId, status }) => ({ requestId, status })),
    [
      { requestId: 'pending-1', status: 'uncertain' },
      { requestId: 'failed-1', status: 'failed' },
    ]
  );
  assert.match(tracker.entries[0].status === 'uncertain' ? tracker.entries[0].message : '', /restarted/);
});

test('bounds pending and recoverable submission records', () => {
  const tracker = new TerminalSubmissionTracker({
    maximumPending: 2,
    maximumRecoverable: 1,
    now: () => 1_000,
  });
  assert.equal(tracker.track({ requestId: 'request-1', draft: 'First' }), true);
  assert.equal(tracker.track({ requestId: 'request-2', draft: 'Second' }), true);
  assert.equal(tracker.track({ requestId: 'request-3', draft: 'Third' }), false);

  tracker.applyResult({
    type: 'submission-result',
    requestId: 'request-1',
    status: 'failed',
    message: 'First error',
  });
  assert.equal(tracker.track({ requestId: 'request-3', draft: 'Third' }), true);
  assert.equal(tracker.track({ requestId: 'request-3', draft: 'Duplicate' }), false);
  tracker.applyResult({
    type: 'submission-result',
    requestId: 'request-2',
    status: 'failed',
    message: 'Second error',
  });

  assert.deepEqual(
    tracker.entries.map(({ requestId, status }) => ({ requestId, status })),
    [
      { requestId: 'request-3', status: 'pending' },
      { requestId: 'request-2', status: 'failed' },
    ]
  );
});
