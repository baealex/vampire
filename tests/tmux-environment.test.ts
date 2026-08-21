import assert from 'node:assert/strict';
import test from 'node:test';
import * as tmux from '../src/lib/features/terminal/server/tmux.ts';

test('keeps Vampire server configuration out of new tmux sessions', () => {
  const sourceEnvironment = {
    HOME: '/tmp/home',
    PATH: '/usr/local/bin:/usr/bin',
    VAMPIRE_CUSTOM_SERVER_OPTION: 'private',
    VAMPIRE_TOKEN: 'secret',
  };
  const launch = tmux.tmuxSessionLaunch('vampire-workspace', '/tmp/project', sourceEnvironment);
  const newWorkspaceIndex = launch.arguments.indexOf('new-session');
  const environmentCommands = launch.arguments.slice(0, newWorkspaceIndex);
  const removedKeys: string[] = [];

  for (let index = 0; index < environmentCommands.length; index += 4) {
    assert.deepEqual(environmentCommands.slice(index, index + 4), [
      'set-environment',
      '-gr',
      environmentCommands[index + 2],
      ';',
    ]);
    removedKeys.push(environmentCommands[index + 2]);
  }

  assert.deepEqual(launch.environment, {
    HOME: '/tmp/home',
    PATH: '/usr/local/bin:/usr/bin',
  });
  assert.ok(removedKeys.includes('VAMPIRE_TOKEN'));
  assert.ok(removedKeys.includes('VAMPIRE_CUSTOM_SERVER_OPTION'));
  assert.deepEqual(launch.arguments.slice(newWorkspaceIndex), [
    'new-session',
    '-d',
    '-s',
    'vampire-workspace',
    '-c',
    '/tmp/project',
    '-P',
    '-F',
    '#{session_name}\t#{session_created}\t#{session_attached}\t#{window_index}\t#{window_id}\t#{window_name}\t#{window_active}\t#{window_activity}\t#{pane_id}\t#{pane_current_command}\t#{pane_pid}\t#{pane_title}\t#{@vampire_background_command}\t#{@vampire_background_started_at}\t#{pane_dead}\t#{pane_dead_status}',
  ]);
  assert.deepEqual(tmux.tmuxPromptSubmissionArguments('@12', 'First line\nsecond line', false), [
    'send-keys',
    '-t',
    '@12',
    '-l',
    '--',
    'First line second line',
  ]);
});

test('treats a missing tmux server socket as an empty server', () => {
  const error = Object.assign(new Error('Command failed: tmux list-windows'), {
    code: 1,
    stderr: 'error connecting to /tmp/tmux-1001/default (No such file or directory)',
  });

  assert.equal(tmux.isTmuxUnavailable(error), true);
});

test('submits an automation prompt literally to one terminal before pressing Enter', () => {
  assert.deepEqual(tmux.tmuxPromptSubmissionArguments('@12', 'Review;\ndo not run $HOME', true), [
    'send-keys',
    '-t',
    '@12',
    '-l',
    '--',
    '\u001b[200~Review;\rdo not run $HOME\u001b[201~',
  ]);
  assert.deepEqual(tmux.tmuxPromptEnterArguments('@12'), ['send-keys', '-t', '@12', 'Enter']);
  assert.throws(() => tmux.tmuxPromptSubmissionArguments('workspace', 'unsafe target', false), /terminal identifier/i);
});

test('labels workspaces with the lower-case executable at the front of the command', () => {
  const workspaces = tmux.parseTmuxSessions(
    [
      'vampire-npm\t1\t0\t0\t@0\tnpm\t1\t2\t%0\tnpm i\t0\t',
      'vampire-codex\t1\t0\t0\t@1\tcodex\t1\t2\t%1\tCodex --project /tmp/project\t0\t',
      'vampire-shell\t1\t0\t0\t@2\tzsh\t1\t2\t%2\tzsh\t0\t',
    ].join('\n')
  );

  assert.deepEqual(
    workspaces.map((workspace) => workspace.foregroundProcess),
    [
      { kind: 'command', label: 'npm' },
      { kind: 'command', label: 'codex' },
      { kind: 'shell', label: 'zsh' },
    ]
  );
});

test('follows a single foreground child without parsing command arguments', () => {
  const processes = new Map([
    [10, { pid: 10, ppid: 1, pgid: 10, tpgid: 11, command: '-zsh' }],
    [11, { pid: 11, ppid: 10, pgid: 11, tpgid: 11, command: 'runtime /path/launcher' }],
    [12, { pid: 12, ppid: 11, pgid: 12, tpgid: 11, command: '/tools/agent' }],
    [13, { pid: 13, ppid: 12, pgid: 13, tpgid: 11, command: '/tools/helper-one' }],
    [14, { pid: 14, ppid: 12, pgid: 14, tpgid: 11, command: '/tools/helper-two' }],
  ]);
  const [workspace] = tmux.parseTmuxSessions('workspace\t1\t0\t0\t@0\truntime\t1\t2\t%0\truntime\t10\t', processes);

  assert.deepEqual(workspace.foregroundProcess, { kind: 'command', label: 'agent' });
});

test('groups tmux windows while keeping background activity out of the main workspace timestamp', () => {
  const [workspace] = tmux.parseTmuxSessions(
    [
      'workspace\t1\t2\t0\t@0\tprimary\t0\t3\t%0\tcodex\t0\t',
      'workspace\t1\t2\t1\t@1\tserver\t1\t5\t%1\tnode\t0\t',
    ].join('\n')
  );

  assert.equal(workspace.name, 'workspace');
  assert.equal(workspace.lastOutputAt, 3_000);
  assert.deepEqual(workspace.foregroundProcess, { kind: 'command', label: 'codex' });
  assert.deepEqual(workspace.terminals, [
    {
      id: '@0',
      index: 0,
      name: 'primary',
      active: false,
      lastOutputAt: 3_000,
      foregroundProcess: { kind: 'command', label: 'codex' },
      command: null,
      startedAt: null,
      state: 'running',
      exitCode: null,
    },
    {
      id: '@1',
      index: 1,
      name: 'server',
      active: true,
      lastOutputAt: 5_000,
      foregroundProcess: { kind: 'command', label: 'node' },
      command: null,
      startedAt: null,
      state: 'running',
      exitCode: null,
    },
  ]);
});

test('describes managed background commands and their exit status', () => {
  const workspaces = tmux.parseTmuxSessions(
    [
      [
        'background-running',
        '1',
        '0',
        '1',
        '@1',
        'pnpm dev',
        '0',
        '5',
        '%1',
        'node',
        '0',
        '',
        'pnpm dev',
        '1712345678000',
        '0',
        '',
      ].join('\t'),
      [
        'background-exited',
        '1',
        '0',
        '1',
        '@2',
        'tests',
        '0',
        '6',
        '%2',
        'zsh',
        '0',
        '',
        'pnpm test',
        '1712345680000',
        '1',
        '7',
      ].join('\t'),
    ].join('\n')
  );

  assert.deepEqual(workspaces[0].terminals[0], {
    id: '@1',
    index: 1,
    name: 'pnpm dev',
    active: false,
    lastOutputAt: 5_000,
    foregroundProcess: { kind: 'command', label: 'node' },
    command: 'pnpm dev',
    startedAt: 1_712_345_678_000,
    state: 'running',
    exitCode: null,
  });
  assert.deepEqual(workspaces[1].terminals[0], {
    id: '@2',
    index: 1,
    name: 'tests',
    active: false,
    lastOutputAt: 6_000,
    foregroundProcess: null,
    command: 'pnpm test',
    startedAt: 1_712_345_680_000,
    state: 'exited',
    exitCode: 7,
  });
});

test('removes trailing tmux pane padding without changing log formatting', () => {
  assert.equal(
    tmux.stripTmuxCapturePadding('\nfirst line\n\n  indented line  \n\n\n'),
    '\nfirst line\n\n  indented line  '
  );
  assert.equal(tmux.stripTmuxCapturePadding('\n\n\n'), '');
});

test('parses the lightweight tmux output activity snapshot', () => {
  assert.deepEqual(
    tmux.parseTmuxSessionActivity(
      ['vampire-one\t0\t1712345678', 'vampire-one\t1\t1712345682', 'vampire-two\t3\t1712345680'].join('\n')
    ),
    [
      { name: 'vampire-one', lastOutputAt: 1_712_345_678_000, mainLastOutputAt: 1_712_345_678_000 },
      { name: 'vampire-two', lastOutputAt: 1_712_345_680_000, mainLastOutputAt: 1_712_345_680_000 },
    ]
  );
});
