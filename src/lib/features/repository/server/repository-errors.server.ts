export type RepositoryReadErrorReason =
  | 'conflict'
  | 'invalid-path'
  | 'not-found'
  | 'not-git'
  | 'too-large'
  | 'unsupported-file'
  | 'command-failed';

export class RepositoryReadError extends Error {
  readonly reason: RepositoryReadErrorReason;

  constructor(reason: RepositoryReadErrorReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

export function repositoryError(reason: RepositoryReadErrorReason, message: string): RepositoryReadError {
  return new RepositoryReadError(reason, message);
}
