import { encodeWorkspaceServerMessage, type WorkspaceServerMessage } from './workspace-protocol.ts';

export type WorkspaceAuthenticationEvent = 'authentication-expired' | 'authentication-revoked';

export function encodeWorkspaceEvent(payload: WorkspaceServerMessage): string {
  return `data: ${encodeWorkspaceServerMessage(payload)}\n\n`;
}

export function encodeWorkspaceAuthenticationEvent(type: WorkspaceAuthenticationEvent): string {
  return `event: ${type}\ndata: {}\n\n`;
}

export const WORKSPACE_EVENT_STREAM_HEARTBEAT = ': keepalive\n\n';
