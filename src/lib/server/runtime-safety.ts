export function automaticCommandsAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VAMPIRE_SAFE_DEVELOPMENT !== '1';
}
