export function automaticCommandsAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VAMPIRE_SAFE_DEVELOPMENT !== '1';
}

export function statusWidgetCommandsAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return automaticCommandsAllowed(env) || env.VAMPIRE_ALLOW_STATUS_WIDGET_COMMANDS === '1';
}
