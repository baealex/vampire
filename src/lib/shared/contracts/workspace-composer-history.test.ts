import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_WORKSPACE_COMPOSER_PROMPTS,
  MAX_WORKSPACE_COMPOSER_PROMPTS,
  normalizeWorkspaceComposerPromptHistory,
  WORKSPACE_COMPOSER_PROMPT_PREVIEW_MAX_LENGTH,
  workspaceComposerPromptPreview,
} from './workspace-composer-history.ts';

test('normalizes valid prompt history and keeps the newest bounded entries', () => {
  const history = Array.from({ length: MAX_WORKSPACE_COMPOSER_PROMPTS + 2 }, (_, index) => ({
    id: `prompt-${index}`,
    text: `Prompt ${index}`,
    submittedAt: index,
  }));

  assert.deepEqual(
    normalizeWorkspaceComposerPromptHistory([null, ...history]).map((prompt) => prompt.id),
    history.slice(-DEFAULT_WORKSPACE_COMPOSER_PROMPTS).map((prompt) => prompt.id)
  );
  assert.deepEqual(
    normalizeWorkspaceComposerPromptHistory(history, 3).map((prompt) => prompt.id),
    history.slice(-3).map((prompt) => prompt.id)
  );
});

test('truncates previews without splitting unicode characters', () => {
  const preview = workspaceComposerPromptPreview([
    {
      id: 'unicode',
      text: `${'a'.repeat(WORKSPACE_COMPOSER_PROMPT_PREVIEW_MAX_LENGTH - 1)}🧛more`,
      submittedAt: 1,
    },
  ]);

  assert.equal(preview?.text, `${'a'.repeat(WORKSPACE_COMPOSER_PROMPT_PREVIEW_MAX_LENGTH - 1)}…`);
  assert.equal(preview?.text.includes('\ud83e'), false);
});

test('creates a single-line preview from the most recent exact prompt', () => {
  assert.deepEqual(
    workspaceComposerPromptPreview([
      { id: 'first', text: 'Earlier prompt', submittedAt: 1 },
      { id: 'last', text: '  Review the queue.\nThen run the tests.  ', submittedAt: 2 },
    ]),
    { text: 'Review the queue. Then run the tests.', submittedAt: 2 }
  );
});
