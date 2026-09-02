export const DEFAULT_WORKSPACE_COMPOSER_TEMPLATE = '{{ prompts }}';
export const WORKSPACE_COMPOSER_TEMPLATE_MAX_LENGTH = 16 * 1_024;

export function isWorkspaceComposerTemplate(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= WORKSPACE_COMPOSER_TEMPLATE_MAX_LENGTH &&
    !value.includes('\0')
  );
}
