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
