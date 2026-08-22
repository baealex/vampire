import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function vampireStatePath(): string {
  const directory = process.env.VAMPIRE_STATE_DIR?.trim() || join(homedir(), '.vampire');
  return join(resolve(directory), 'sessions.json');
}
