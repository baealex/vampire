import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { findDesignSystemViolations } from '../../../../tools/design-system.ts';

const root = resolve(import.meta.dirname, '../../../..');
const sourceRoot = join(root, 'src');

test('keeps shared control chrome inside shared UI components', async () => {
  assert.deepEqual(
    await findDesignSystemViolations(),
    [],
    'use shared UI components and semantic props instead of legacy style contracts'
  );
});

test('keeps reusable controls style-owned', async () => {
  const componentNames = [
    'Button',
    'Field',
    'Input',
    'Select',
    'Textarea',
    'DialogActions',
    'DialogChrome',
    'DialogToolbar',
    'DropdownMenuHeading',
    'DropdownMenuItem',
    'DropdownMenuSeparator',
    'DropdownMenuShell',
  ];
  const missingStyles: string[] = [];

  for (const name of componentNames) {
    const source = await readFile(join(sourceRoot, 'lib', 'shared', 'ui', `${name}.svelte`), 'utf8');
    if (!/<style[\s>]/.test(source)) missingStyles.push(name);
  }

  assert.deepEqual(missingStyles, []);
});
