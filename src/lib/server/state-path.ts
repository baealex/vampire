import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const VAMPIRE_REGISTRY_FILE = 'registry.json';
export const VAMPIRE_GLOBAL_DIRECTORY = 'global';
export const VAMPIRE_WORKSPACES_DIRECTORY = 'workspaces';
export const VAMPIRE_AGENT_SUPPORT_DIRECTORY = 'agent-support';
export const VAMPIRE_LEGACY_STATE_FILE = 'sessions.json';
export const VAMPIRE_GLOBAL_SETTINGS_FILE = 'settings.json';
export const VAMPIRE_GLOBAL_LAUNCH_PROFILES_FILE = 'launch-profiles.json';
export const VAMPIRE_GLOBAL_STATUS_WIDGETS_FILE = 'status-widgets.json';
export const VAMPIRE_GLOBAL_TERMINAL_INPUT_FILE = 'terminal-input.json';
export const VAMPIRE_GLOBAL_COMPOSER_HISTORY_FILE = 'composer-history.json';
export const VAMPIRE_WORKSPACE_SETTINGS_FILE = 'settings.json';
export const VAMPIRE_WORKSPACE_AUTOMATIONS_FILE = 'automations.json';
export const VAMPIRE_WORKSPACE_BACKGROUND_FILE = 'background.json';
export const VAMPIRE_WORKSPACE_NOTE_FILE = 'note.md';
export const VAMPIRE_WORKSPACE_COMPOSER_HISTORY_FILE = 'composer-history.json';
export const VAMPIRE_AGENT_GUIDES_DIRECTORY = 'guides';
export const VAMPIRE_AGENT_REQUESTS_DIRECTORY = 'requests';
const SAFE_WORKSPACE_STATE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function vampireStateDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.VAMPIRE_STATE_DIR?.trim() || join(homedir(), '.vampire'));
}

export function vampireStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(vampireStateDirectory(env), VAMPIRE_LEGACY_STATE_FILE);
}

export function vampireRegistryPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(vampireStateDirectory(env), VAMPIRE_REGISTRY_FILE);
}

export function vampireGlobalStatePath(name: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(vampireStateDirectory(env), VAMPIRE_GLOBAL_DIRECTORY, name);
}

export function vampireWorkspaceStateKey(workspaceId: string): string {
  return SAFE_WORKSPACE_STATE_ID.test(workspaceId)
    ? workspaceId
    : createHash('sha256').update(workspaceId).digest('hex');
}

export function vampireWorkspaceStateDirectory(workspaceId: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(vampireStateDirectory(env), VAMPIRE_WORKSPACES_DIRECTORY, vampireWorkspaceStateKey(workspaceId));
}

export function vampireWorkspaceStatePath(
  workspaceId: string,
  name: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  return join(vampireWorkspaceStateDirectory(workspaceId, env), name);
}

export function vampireAgentSupportPath(name: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(vampireStateDirectory(env), VAMPIRE_AGENT_SUPPORT_DIRECTORY, name);
}
