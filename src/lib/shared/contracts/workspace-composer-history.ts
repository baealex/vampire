export const MIN_WORKSPACE_COMPOSER_PROMPTS = 1;
export const DEFAULT_WORKSPACE_COMPOSER_PROMPTS = 20;
export const MAX_WORKSPACE_COMPOSER_PROMPTS = 100;
export const WORKSPACE_COMPOSER_PROMPT_MAX_LENGTH = 64 * 1_024;
export const WORKSPACE_COMPOSER_PROMPT_PREVIEW_MAX_LENGTH = 180;

export type WorkspaceComposerHistorySettings = {
  enabled: boolean;
  limit: number;
};

export const DEFAULT_WORKSPACE_COMPOSER_HISTORY_SETTINGS: WorkspaceComposerHistorySettings = {
  enabled: true,
  limit: DEFAULT_WORKSPACE_COMPOSER_PROMPTS,
};

export type WorkspaceComposerPrompt = {
  id: string;
  text: string;
  submittedAt: number;
};

export type WorkspaceComposerPromptPreview = {
  text: string;
  submittedAt: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isWorkspaceComposerPrompt(value: unknown): value is WorkspaceComposerPrompt {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    value.id.length <= 128 &&
    typeof value.text === 'string' &&
    value.text.trim().length > 0 &&
    value.text.length <= WORKSPACE_COMPOSER_PROMPT_MAX_LENGTH &&
    typeof value.submittedAt === 'number' &&
    Number.isSafeInteger(value.submittedAt) &&
    value.submittedAt >= 0
  );
}

export function isWorkspaceComposerPromptPreview(value: unknown): value is WorkspaceComposerPromptPreview | null {
  return (
    value === null ||
    (isRecord(value) &&
      typeof value.text === 'string' &&
      value.text.trim().length > 0 &&
      value.text.length <= WORKSPACE_COMPOSER_PROMPT_PREVIEW_MAX_LENGTH &&
      typeof value.submittedAt === 'number' &&
      Number.isSafeInteger(value.submittedAt) &&
      value.submittedAt >= 0)
  );
}

export function isWorkspaceComposerHistorySettings(value: unknown): value is WorkspaceComposerHistorySettings {
  return (
    isRecord(value) &&
    typeof value.enabled === 'boolean' &&
    Number.isInteger(value.limit) &&
    Number(value.limit) >= MIN_WORKSPACE_COMPOSER_PROMPTS &&
    Number(value.limit) <= MAX_WORKSPACE_COMPOSER_PROMPTS
  );
}

export function normalizeWorkspaceComposerPromptHistory(
  value: unknown,
  limit = DEFAULT_WORKSPACE_COMPOSER_PROMPTS
): WorkspaceComposerPrompt[] {
  if (!Array.isArray(value)) return [];
  const normalizedLimit = Math.min(
    MAX_WORKSPACE_COMPOSER_PROMPTS,
    Math.max(MIN_WORKSPACE_COMPOSER_PROMPTS, Math.trunc(limit))
  );
  return value
    .filter(isWorkspaceComposerPrompt)
    .slice(-normalizedLimit)
    .map((prompt) => ({ ...prompt }));
}

export function workspaceComposerPromptPreview(
  history: readonly WorkspaceComposerPrompt[]
): WorkspaceComposerPromptPreview | null {
  const prompt = history.at(-1);
  if (!prompt) return null;
  const text = prompt.text.replace(/\s+/g, ' ').trim();
  const characters = [...text];
  return {
    text:
      characters.length > WORKSPACE_COMPOSER_PROMPT_PREVIEW_MAX_LENGTH
        ? `${characters
            .slice(0, WORKSPACE_COMPOSER_PROMPT_PREVIEW_MAX_LENGTH - 1)
            .join('')
            .trimEnd()}…`
        : text,
    submittedAt: prompt.submittedAt,
  };
}
