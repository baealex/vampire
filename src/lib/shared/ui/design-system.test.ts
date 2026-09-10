import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { findDesignSystemViolations } from '../../../../tools/design-system.ts';

const root = resolve(import.meta.dirname, '../../../..');
const sharedUiRoot = join(root, 'packages', 'client', 'src', 'shared', 'ui');

test('keeps shared control chrome inside shared UI components', async () => {
  assert.deepEqual(
    await findDesignSystemViolations(),
    [],
    'use shared UI components and semantic props instead of legacy style contracts',
  );
});

test('keeps reusable controls inside the React shared UI layer', async () => {
  const componentNames = [
    'Button',
    'Field',
    'Input',
    'Select',
    'Textarea',
    'Dialog',
    'DropdownMenu',
    'ManagementSurface',
    'Spinner',
    'ToolbarButton',
  ];
  const missingComponents: string[] = [];

  for (const name of componentNames) {
    try {
      await readFile(join(sharedUiRoot, `${name}.tsx`), 'utf8');
    } catch {
      missingComponents.push(name);
    }
  }

  assert.deepEqual(missingComponents, []);
});
