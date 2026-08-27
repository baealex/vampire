import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function vampireStateDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.VAMPIRE_STATE_DIR?.trim() || join(homedir(), '.vampire'));
}

export function vampireStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(vampireStateDirectory(env), 'sessions.json');
}
