import assert from 'node:assert/strict';
import test from 'node:test';
import {
  encodeWorkspaceAuthenticationEvent,
  encodeWorkspaceEvent,
  WORKSPACE_EVENT_STREAM_HEARTBEAT,
} from './workspace-event-stream.ts';

test('encodes workspace payloads as default SSE messages for the existing protocol parser', () => {
  assert.equal(
    encodeWorkspaceEvent({ type: 'workspace-removed', id: 'workspace-1' }),
    'data: {"type":"workspace-removed","id":"workspace-1"}\n\n'
  );
});

test('encodes authentication endings as named SSE events and keeps heartbeat payload-free', () => {
  assert.equal(
    encodeWorkspaceAuthenticationEvent('authentication-expired'),
    'event: authentication-expired\ndata: {}\n\n'
  );
  assert.equal(
    encodeWorkspaceAuthenticationEvent('authentication-revoked'),
    'event: authentication-revoked\ndata: {}\n\n'
  );
  assert.equal(WORKSPACE_EVENT_STREAM_HEARTBEAT, ': keepalive\n\n');
});
