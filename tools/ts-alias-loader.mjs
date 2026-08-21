import { resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sourceRoot = resolvePath(fileURLToPath(new URL('../src/', import.meta.url)));

export function resolve(specifier, context, nextResolve) {
	if (specifier === '~' || specifier.startsWith('~/')) {
		const sourcePath = specifier === '~' ? sourceRoot : resolvePath(sourceRoot, specifier.slice(2));
		return nextResolve(pathToFileURL(sourcePath).href, context);
	}

	return nextResolve(specifier, context);
}
