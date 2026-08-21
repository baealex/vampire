import type { LaunchProfile } from './workspace.ts';

export const MAX_LAUNCH_PROFILES = 16;
export const LAUNCH_PROFILE_NAME_MAX_LENGTH = 80;
export const LAUNCH_PROFILE_COMMAND_MAX_LENGTH = 1_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isSingleLine(value: string): boolean {
  return !/[\0\r\n\t]/.test(value);
}

export function isLaunchProfile(value: unknown): value is LaunchProfile {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id.trim().length > 0 &&
    value.id.length <= 100 &&
    isSingleLine(value.id) &&
    typeof value.name === 'string' &&
    value.name.trim().length > 0 &&
    value.name.length <= LAUNCH_PROFILE_NAME_MAX_LENGTH &&
    isSingleLine(value.name) &&
    typeof value.command === 'string' &&
    value.command.trim().length > 0 &&
    value.command.length <= LAUNCH_PROFILE_COMMAND_MAX_LENGTH &&
    isSingleLine(value.command)
  );
}

export function isLaunchProfileList(value: unknown): value is LaunchProfile[] {
  if (!Array.isArray(value) || value.length > MAX_LAUNCH_PROFILES || !value.every(isLaunchProfile)) return false;
  const ids = value.map((profile) => profile.id.trim());
  return new Set(ids).size === ids.length;
}

export function normalizeLaunchProfiles(value: unknown): LaunchProfile[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const profiles: LaunchProfile[] = [];
  for (const candidate of value) {
    if (!isLaunchProfile(candidate)) continue;
    const profile = {
      id: candidate.id.trim(),
      name: candidate.name.trim(),
      command: candidate.command.trim(),
    };
    if (seen.has(profile.id)) continue;
    seen.add(profile.id);
    profiles.push(profile);
    if (profiles.length >= MAX_LAUNCH_PROFILES) break;
  }
  return profiles;
}
