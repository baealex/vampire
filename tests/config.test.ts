import assert from 'node:assert/strict';
import { delimiter, join, resolve } from 'node:path';
import test from 'node:test';
import { parseWorkspaceRootPaths, runtimeConfig } from '../src/lib/server/runtime-config.ts';

test('defaults workspace browsing to the server launch directory', () => {
	assert.deepEqual(
		parseWorkspaceRootPaths(undefined, '/tmp/vampire-project', '/tmp/home'),
		['/tmp/vampire-project']
	);
});

test('parses, expands, resolves, and deduplicates configured workspace roots', () => {
	const baseDirectory = '/tmp/vampire-project';
	const homeDirectory = '/tmp/home';
	const configured = [
		'~/Code',
		join(baseDirectory, 'Projects'),
		join(homeDirectory, 'Code'),
		'./Projects'
	].join(delimiter);

	assert.deepEqual(parseWorkspaceRootPaths(configured, baseDirectory, homeDirectory), [
		'/tmp/home/Code',
		'/tmp/vampire-project/Projects'
	]);
});

test('includes parsed workspace roots in runtime configuration', () => {
	const config = runtimeConfig({
		VAMPIRE_HOST: '127.0.0.1',
		VAMPIRE_PORT: '7677',
		VAMPIRE_WORKSPACE_ROOTS: '/tmp/one:/tmp/two'
	});

	assert.deepEqual(config.workspaceRoots, [resolve('/tmp/one'), resolve('/tmp/two')]);
});
