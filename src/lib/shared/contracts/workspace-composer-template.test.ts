import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_WORKSPACE_COMPOSER_TEMPLATE,
  isWorkspaceComposerTemplate,
  WORKSPACE_COMPOSER_TEMPLATE_MAX_LENGTH,
} from './workspace-composer-template.ts';

test('accepts bounded workspace Composer templates', () => {
  assert.equal(isWorkspaceComposerTemplate(DEFAULT_WORKSPACE_COMPOSER_TEMPLATE), true);
  assert.equal(isWorkspaceComposerTemplate(''), false);
  assert.equal(isWorkspaceComposerTemplate('{{ prompts }}\0'), false);
  assert.equal(isWorkspaceComposerTemplate('x'.repeat(WORKSPACE_COMPOSER_TEMPLATE_MAX_LENGTH + 1)), false);
});
