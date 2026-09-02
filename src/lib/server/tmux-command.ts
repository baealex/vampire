const TMUX_SOCKET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export function tmuxCommandArguments(
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv = process.env
): string[] {
  const socketName = environment.VAMPIRE_TMUX_SOCKET_NAME?.trim();
  if (!socketName) return [...arguments_];
  if (!TMUX_SOCKET_NAME_PATTERN.test(socketName)) {
    throw new Error('VAMPIRE_TMUX_SOCKET_NAME must be a safe tmux socket name.');
  }
  return ['-L', socketName, ...arguments_];
}
