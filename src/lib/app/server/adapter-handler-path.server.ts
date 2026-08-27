import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

type FileExists = (path: string) => boolean;

export function resolveAdapterHandlerPath(
  moduleDirectory: string,
  adapterOutputDirectory: string,
  fileExists: FileExists = existsSync
): string {
  const candidates = [
    resolve(moduleDirectory, '../../../..', adapterOutputDirectory, 'handler.js'),
    resolve(moduleDirectory, '..', adapterOutputDirectory, 'handler.js'),
  ];
  const handlerPath = candidates.find(fileExists);
  if (handlerPath) return handlerPath;

  throw new Error(`Unable to locate the SvelteKit adapter handler in ${candidates.join(' or ')}`);
}
