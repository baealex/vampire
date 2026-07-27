import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '..');
const source = await readFile(resolve(root, 'src/lib/server/tmux.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
	compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
}).outputText;
const tmux = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

test('keeps Vampire server configuration out of new tmux sessions', () => {
	const sourceEnvironment = {
		HOME: '/tmp/home',
		PATH: '/usr/local/bin:/usr/bin',
		VAMPIRE_CUSTOM_SERVER_OPTION: 'private',
		VAMPIRE_TOKEN: 'secret'
	};
	const launch = tmux.tmuxSessionLaunch('vampire-workspace', '/tmp/project', sourceEnvironment);
	const newSessionIndex = launch.arguments.indexOf('new-session');
	const environmentCommands = launch.arguments.slice(0, newSessionIndex);
	const removedKeys = [];

	for (let index = 0; index < environmentCommands.length; index += 4) {
		assert.deepEqual(environmentCommands.slice(index, index + 4), [
			'set-environment',
			'-gr',
			environmentCommands[index + 2],
			';'
		]);
		removedKeys.push(environmentCommands[index + 2]);
	}

	assert.deepEqual(launch.environment, {
		HOME: '/tmp/home',
		PATH: '/usr/local/bin:/usr/bin'
	});
	assert.ok(removedKeys.includes('VAMPIRE_TOKEN'));
	assert.ok(removedKeys.includes('VAMPIRE_CUSTOM_SERVER_OPTION'));
	assert.deepEqual(launch.arguments.slice(newSessionIndex), [
		'new-session',
		'-d',
		'-s',
		'vampire-workspace',
		'-c',
		'/tmp/project'
	]);
});

test('labels sessions with the lower-case executable at the front of the command', () => {
	const sessions = tmux.parseTmuxSessions([
		'vampire-npm\t1\t2\t0\tnpm i\t0\t',
		'vampire-codex\t1\t2\t0\tCodex --project /tmp/project\t0\t',
		'vampire-shell\t1\t2\t0\tzsh\t0\t'
	].join('\n'));

	assert.deepEqual(sessions.map((session) => session.foregroundProcess), [
		{ kind: 'command', label: 'npm' },
		{ kind: 'command', label: 'codex' },
		{ kind: 'shell', label: 'zsh' }
	]);
});

test('follows a single foreground child without parsing command arguments', () => {
	const processes = new Map([
		[10, { pid: 10, ppid: 1, pgid: 10, tpgid: 11, command: '-zsh' }],
		[11, { pid: 11, ppid: 10, pgid: 11, tpgid: 11, command: 'runtime /path/launcher' }],
		[12, { pid: 12, ppid: 11, pgid: 12, tpgid: 11, command: '/tools/agent' }],
		[13, { pid: 13, ppid: 12, pgid: 13, tpgid: 11, command: '/tools/helper-one' }],
		[14, { pid: 14, ppid: 12, pgid: 14, tpgid: 11, command: '/tools/helper-two' }]
	]);
	const [session] = tmux.parseTmuxSessions('workspace\t1\t2\t0\truntime\t10\t', processes);

	assert.deepEqual(session.foregroundProcess, { kind: 'command', label: 'agent' });
});
