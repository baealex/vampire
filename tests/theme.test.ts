import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const sourceRoot = join(root, 'src');
const tokenFile = join(sourceRoot, 'lib', 'theme', 'tokens.css');
const colorLiteral = /#[0-9a-fA-F]{3,8}(?![0-9A-Za-z_-])|(?:rgb|rgba|hsl|hsla)\(/;
const namedColorDeclaration = /(?:color|background(?:-color)?|border(?:-[\w-]+)?|fill|stroke)\s*:\s*(?:white|black|red|green|blue|gray|grey|orange|yellow|purple|pink|brown)\b/i;

async function sourceFiles(directory: string): Promise<string[]> {
	const files: string[] = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...await sourceFiles(path));
		else if (['.css', '.svelte', '.ts'].includes(extname(entry.name))) files.push(path);
	}
	return files;
}

function selectorBlock(source: string, selector: string): string {
	const start = source.indexOf(`${selector} {`);
	assert.ok(start >= 0, `${selector} theme block must exist`);
	const openingBrace = source.indexOf('{', start);
	let depth = 0;
	for (let index = openingBrace; index < source.length; index += 1) {
		if (source[index] === '{') depth += 1;
		if (source[index] === '}') depth -= 1;
		if (depth === 0) return source.slice(openingBrace + 1, index);
	}
	throw new Error(`${selector} theme block is not closed`);
}

function tokenNames(source: string): Set<string> {
	return new Set([...source.matchAll(/--([a-z0-9-]+)\s*:/g)].map((match) => match[1]));
}

test('keeps component colors behind shared theme tokens', async () => {
	const violations: string[] = [];
	for (const file of await sourceFiles(sourceRoot)) {
		if (file === tokenFile) continue;
		const source = await readFile(file, 'utf8');
		if (colorLiteral.test(source) || namedColorDeclaration.test(source)) {
			violations.push(relative(root, file));
		}
	}
	assert.deepEqual(violations, [], 'put color values in src/lib/theme/tokens.css instead of components');
});

test('defines the same token surface for dark and light themes', async () => {
	const source = await readFile(tokenFile, 'utf8');
	const darkTokens = [...tokenNames(selectorBlock(source, ':root[data-theme="dark"]'))].sort();
	const lightTokens = [...tokenNames(selectorBlock(source, ':root[data-theme="light"]'))].sort();
	assert.deepEqual(lightTokens, darkTokens);
});

test('defines every theme token consumed by the UI', async () => {
	const tokens = tokenNames(await readFile(tokenFile, 'utf8'));
	const missing = new Set<string>();
	for (const file of await sourceFiles(sourceRoot)) {
		if (file === tokenFile) continue;
		const source = await readFile(file, 'utf8');
		for (const match of source.matchAll(/(?:var\(|cssToken\(['"])(--[a-z0-9-]+)/g)) {
			const themeToken = /^--(?:color|shadow)-/.test(match[1])
				|| /^--terminal-(?:black|red|green|yellow|blue|magenta|cyan|white|bright-)/.test(match[1]);
			if (themeToken && !tokens.has(match[1].slice(2))) {
				missing.add(match[1]);
			}
		}
	}
	assert.deepEqual([...missing].sort(), []);
});

test('uses the same persisted theme key before and after hydration', async () => {
	const initializer = await readFile(join(root, 'static', 'theme-init.js'), 'utf8');
	const state = await readFile(join(sourceRoot, 'lib', 'theme', 'theme.svelte.ts'), 'utf8');
	assert.match(initializer, /vampire:theme/);
	assert.match(state, /vampire:theme/);
});

test('overrides xterm viewport defaults with the active terminal theme', async () => {
	const terminalViewport = await readFile(join(sourceRoot, 'lib', 'terminal', 'TerminalViewport.svelte'), 'utf8');
	assert.match(
		terminalViewport,
		/\.xterm-viewport\)[^{]*\{[^}]*background:\s*var\(--color-terminal-background\)/s
	);
});
