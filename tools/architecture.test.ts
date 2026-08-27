import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { findArchitectureViolations } from './architecture.ts';

test('the repository has no architecture violations', async () => {
  assert.deepEqual(await findArchitectureViolations(), []);
});

test('the architecture checker rejects upward and peer dependencies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vampire-architecture-'));
  try {
    await mkdir(join(root, 'src/lib/shared'), { recursive: true });
    await mkdir(join(root, 'src/lib/features/terminal/ui'), { recursive: true });
    await mkdir(join(root, 'src/lib/features/workspace/ui'), { recursive: true });
    await mkdir(join(root, 'src/lib/app'), { recursive: true });
    await writeFile(
      join(root, 'src/lib/shared/index.ts'),
      "import Terminal from '~/lib/features/terminal/ui/Terminal.svelte';\n"
    );
    await writeFile(
      join(root, 'src/lib/features/terminal/ui/Terminal.ts'),
      "import Workspace from '~/lib/features/workspace/ui/Workspace.svelte';\n"
    );
    await writeFile(join(root, 'src/lib/features/workspace/ui/Workspace.svelte'), '<div />\n');
    await writeFile(join(root, 'src/lib/features/terminal/ui/Terminal.svelte'), '<div />\n');
    await writeFile(join(root, 'src/lib/app/index.ts'), '<div />\n');

    const violations = await findArchitectureViolations(root);
    assert.equal(violations.length, 2);
    assert.ok(violations.some(({ reason }) => reason.includes('shared')));
    assert.ok(violations.some(({ reason }) => reason.includes('peer feature')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the architecture checker rejects server-only imports from browser-capable modules', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vampire-server-boundary-'));
  try {
    await mkdir(join(root, 'src/lib/server'), { recursive: true });
    await mkdir(join(root, 'src/lib/features/terminal/server'), { recursive: true });
    await mkdir(join(root, 'src/lib/features/terminal/ui'), { recursive: true });
    await mkdir(join(root, 'src/routes'), { recursive: true });
    await writeFile(join(root, 'src/lib/server/runtime.ts'), 'export const runtime = true;\n');
    await writeFile(
      join(root, 'src/lib/features/terminal/server/terminal.server.ts'),
      'export const terminal = true;\n'
    );
    await writeFile(
      join(root, 'src/lib/features/terminal/server/terminal-types.server.ts'),
      'export interface ServerTerminal { id: string }\n'
    );
    await writeFile(
      join(root, 'src/lib/features/terminal/ui/Terminal.svelte'),
      "<script>import { terminal } from '../server/terminal.server.ts';</script>\n"
    );
    await writeFile(
      join(root, 'src/routes/+page.ts'),
      [
        "import { runtime } from '$lib/server/runtime.ts';",
        "import type { ServerTerminal } from '$lib/features/terminal/server/terminal-types.server.ts';",
      ].join('\n')
    );
    await writeFile(join(root, 'src/routes/+server.ts'), "import { runtime } from '$lib/server/runtime.ts';\n");

    const violations = await findArchitectureViolations(root);
    assert.equal(violations.length, 3);
    assert.ok(violations.every(({ reason }) => reason.includes('server-only')));
    assert.ok(violations.some(({ source }) => source.endsWith('/ui/Terminal.svelte')));
    assert.ok(violations.some(({ source }) => source === 'src/routes/+page.ts'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the architecture checker requires protected filenames in app and feature server directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vampire-server-filenames-'));
  try {
    await mkdir(join(root, 'src/lib/app/server'), { recursive: true });
    await mkdir(join(root, 'src/lib/features/terminal/server'), { recursive: true });
    await mkdir(join(root, 'src/lib/server'), { recursive: true });
    await writeFile(join(root, 'src/lib/app/server/bootstrap.ts'), 'export const bootstrap = true;\n');
    await writeFile(join(root, 'src/lib/features/terminal/server/process.ts'), 'export const process = true;\n');
    await writeFile(join(root, 'src/lib/features/terminal/server/process.test.ts'), 'export const fixture = true;\n');
    await writeFile(join(root, 'src/lib/server/runtime.ts'), 'export const runtime = true;\n');

    const violations = await findArchitectureViolations(root);
    assert.equal(violations.length, 2);
    assert.ok(violations.every(({ reason }) => reason.includes('*.server.*')));
    assert.deepEqual(
      violations.map(({ source }) => source),
      ['src/lib/app/server/bootstrap.ts', 'src/lib/features/terminal/server/process.ts']
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
