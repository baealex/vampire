import Handlebars from 'handlebars';
import { DEFAULT_WORKSPACE_COMPOSER_TEMPLATE } from '~/lib/shared/contracts/workspace-composer-template.ts';

export const COMPOSER_TEMPLATE_OUTPUT_MAX_BYTES = 64 * 1_024;

export const COMPOSER_TEMPLATE_VARIABLES = [
  { token: '{{ prompts }}', label: 'Prompt', description: 'The message written in Compose' },
  { token: '{{ today }}', label: 'Today', description: 'Local date in YYYY-MM-DD format' },
  { token: '{{ now }}', label: 'Now', description: 'Current time in ISO 8601 format' },
  { token: '{{ workspace.name }}', label: 'Workspace name', description: 'The current workspace name' },
  { token: '{{ workspace.cwd }}', label: 'Working directory', description: 'The current workspace path' },
] as const;

const SUPPORTED_PATHS = new Set(['prompts', 'today', 'now', 'workspace.name', 'workspace.cwd']);

type ParsedMustacheStatement = {
  escaped: boolean;
  path: { type: string; original: string };
  params: unknown[];
  hash?: { pairs: unknown[] };
};

type ParsedStatement = {
  type: string;
  value?: string;
};

type ParsedProgram = {
  body: ParsedStatement[];
};

export type ComposerTemplateContext = {
  workspace: {
    name: string;
    cwd: string;
  };
};

export type ComposerTemplateRenderResult = {
  text: string;
  error?: string;
  usedFallback: boolean;
};

function localDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function syntaxError(error: unknown): string {
  const message = error instanceof Error ? error.message.split('\n', 1)[0] : 'The template syntax is invalid.';
  return `Template syntax error: ${message}`;
}

function parseComposerTemplate(template: string): { program?: ParsedProgram; error?: string } {
  try {
    return { program: Handlebars.parse(template) as unknown as ParsedProgram };
  } catch (error) {
    return { error: syntaxError(error) };
  }
}

function validateComposerProgram(program: ParsedProgram): string | undefined {
  let promptSlots = 0;
  for (const statement of program.body) {
    if (statement.type === 'ContentStatement' || statement.type === 'CommentStatement') continue;
    if (statement.type !== 'MustacheStatement') {
      return 'Only the provided variables can be used in this template.';
    }
    const mustache = statement as unknown as ParsedMustacheStatement;
    if (
      !mustache.escaped ||
      mustache.path.type !== 'PathExpression' ||
      mustache.params.length > 0 ||
      (mustache.hash?.pairs.length ?? 0) > 0
    ) {
      return 'Only the provided variables can be used in this template.';
    }
    const path = mustache.path.original;
    if (!SUPPORTED_PATHS.has(path)) return `Unknown template variable: {{ ${path} }}`;
    if (path === 'prompts') promptSlots += 1;
  }

  if (promptSlots === 0) return 'Add {{ prompts }} so the message written in Compose is included.';
  if (promptSlots > 1) return 'Use {{ prompts }} exactly once.';
  return undefined;
}

export function validateComposerTemplate(template: string): string | undefined {
  const parsed = parseComposerTemplate(template);
  return parsed.error ?? validateComposerProgram(parsed.program!);
}

export function renderComposerTemplate(
  template: string | undefined,
  prompt: string,
  context: ComposerTemplateContext,
  renderedAt = new Date()
): ComposerTemplateRenderResult {
  const source = template ?? DEFAULT_WORKSPACE_COMPOSER_TEMPLATE;
  const parsed = parseComposerTemplate(source);
  const validationError = parsed.error ?? validateComposerProgram(parsed.program!);
  if (validationError) return { text: prompt, error: validationError, usedFallback: true };

  try {
    const values: Record<string, string> = {
      prompts: prompt,
      today: localDate(renderedAt),
      now: renderedAt.toISOString(),
      'workspace.name': context.workspace.name,
      'workspace.cwd': context.workspace.cwd,
    };
    const text = parsed
      .program!.body.map((statement) => {
        if (statement.type === 'ContentStatement') return statement.value ?? '';
        if (statement.type === 'CommentStatement') return '';
        const path = (statement as unknown as ParsedMustacheStatement).path.original;
        return values[path] ?? '';
      })
      .join('');
    if (new TextEncoder().encode(text).byteLength > COMPOSER_TEMPLATE_OUTPUT_MAX_BYTES) {
      return {
        text: prompt,
        error: 'The rendered template is too large to send. The original prompt will be used.',
        usedFallback: true,
      };
    }
    return { text, usedFallback: false };
  } catch (error) {
    return { text: prompt, error: syntaxError(error), usedFallback: true };
  }
}
