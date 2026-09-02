import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COMPOSER_TEMPLATE_OUTPUT_MAX_BYTES,
  renderComposerTemplate,
  validateComposerTemplate,
} from './composer-template.ts';

const context = { workspace: { name: 'Vampire', cwd: '/work/vampire' } };

test('renders the supported workspace variables without escaping prompt text', () => {
  const renderedAt = new Date(2026, 8, 2, 3, 4, 5);
  const result = renderComposerTemplate(
    'Date: {{ today }}\nNow: {{ now }}\nWorkspace: {{ workspace.name }} ({{ workspace.cwd }})\n\n{{ prompts }}',
    'Check <output> and keep {{ literal }} intact.',
    context,
    renderedAt
  );

  assert.deepEqual(result, {
    text: `Date: 2026-09-02\nNow: ${renderedAt.toISOString()}\nWorkspace: Vampire (/work/vampire)\n\nCheck <output> and keep {{ literal }} intact.`,
    usedFallback: false,
  });
});

test('requires exactly one prompt slot and rejects unexposed Handlebars features', () => {
  assert.match(validateComposerTemplate('No slot') ?? '', /Add \{\{ prompts \}\}/);
  assert.match(validateComposerTemplate('{{ prompts }} {{prompts}}') ?? '', /exactly once/);
  assert.match(validateComposerTemplate('{{ missing }}\n{{ prompts }}') ?? '', /Unknown template variable/);
  assert.match(validateComposerTemplate('{{#if today}}{{ prompts }}{{/if}}') ?? '', /provided variables/);
  assert.match(validateComposerTemplate('{{> prompts }}') ?? '', /provided variables/);
  assert.match(validateComposerTemplate('{{{ prompts }}}') ?? '', /provided variables/);
  assert.match(validateComposerTemplate('{{ prompts value }}') ?? '', /provided variables/);
  assert.equal(validateComposerTemplate('{{ today }}\n{{ prompts }}'), undefined);
});

test('falls back to the original prompt for invalid or oversized templates', () => {
  assert.deepEqual(renderComposerTemplate('No prompt slot', 'Keep me', context), {
    text: 'Keep me',
    error: 'Add {{ prompts }} so the message written in Compose is included.',
    usedFallback: true,
  });
  const oversized = renderComposerTemplate(
    `${'x'.repeat(COMPOSER_TEMPLATE_OUTPUT_MAX_BYTES)}{{ prompts }}`,
    'Keep me',
    context
  );
  assert.equal(oversized.text, 'Keep me');
  assert.equal(oversized.usedFallback, true);
  assert.match(oversized.error ?? '', /too large/);
});
