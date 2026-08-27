import { isAbsolute, relative, sep } from 'node:path';

/**
 * Lexically checks whether a target is equal to or nested below a root.
 * Callers that accept symlinks must compare canonical real paths separately.
 */
export function pathStaysInside(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target);
  return (
    pathFromRoot === '' || (pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
  );
}

export function errorHasCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code);
}
