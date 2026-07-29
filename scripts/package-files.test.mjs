import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { dirname, posix, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('the npm package includes every runtime module reachable from its CLI', async () => {
	const manifest = JSON.parse(await readFile(resolve(repositoryRoot, 'package.json'), 'utf8'));
	const packageFiles = manifest.files.map((path) => posix.normalize(path));
	const pending = Object.values(manifest.bin);
	const visited = new Set();

	while (pending.length > 0) {
		const modulePath = posix.normalize(pending.pop());
		if (visited.has(modulePath)) continue;
		visited.add(modulePath);

		assert.ok(isPackaged(modulePath, packageFiles), `${modulePath} is required at runtime but omitted from package.json files.`);
		if (isGeneratedBuildFile(modulePath)) continue;

		const absolutePath = resolve(repositoryRoot, modulePath);
		try {
			await access(absolutePath);
		} catch (error) {
			throw error;
		}

		const source = await readFile(absolutePath, 'utf8');
		for (const specifier of relativeModuleSpecifiers(source)) {
			pending.push(posix.normalize(posix.join(posix.dirname(modulePath), specifier)));
		}
	}
});

function isPackaged(modulePath, packageFiles) {
	return packageFiles.some((entry) => modulePath === entry || modulePath.startsWith(`${entry}/`));
}

function isGeneratedBuildFile(modulePath) {
	return modulePath.startsWith('build/');
}

function relativeModuleSpecifiers(source) {
	const specifiers = [];
	const importPattern = /(?:import|export)\s+(?:[^'";]*?\s+from\s*)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
	for (const match of source.matchAll(importPattern)) {
		const specifier = match[1] || match[2];
		if (specifier?.startsWith('.')) specifiers.push(specifier);
	}
	return specifiers;
}
