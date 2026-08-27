import { stripVTControlCharacters } from 'node:util';
import {
  STATUS_PLUGIN_MENU_MAX_ITEMS,
  type StatusPluginMenuEntry,
  type StatusPluginMenuTime,
  type StatusPluginOutput,
  type StatusPluginTone,
} from '~/lib/shared/contracts/status-plugin.ts';

const STATUS_TEXT_MAX_LENGTH = 240;
const STATUS_MENU_TEXT_MAX_LENGTH = 1_000;
const STATUS_MENU_VALUE_MAX_LENGTH = 240;
const STATUS_MENU_BADGE_MAX_LENGTH = 80;
const STATUS_HREF_MAX_LENGTH = 2_048;

function cleanText(value: string): string {
  return stripVTControlCharacters(value)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim();
}

function truncate(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  return `${value.slice(0, Math.max(0, maximum - 1))}…`;
}

function cleanLine(value: string, maximum: number): string {
  return truncate(cleanText(value).replace(/\n+/g, ' '), maximum);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function invalidOutput(): never {
  throw new TypeError('Invalid status plugin structured output.');
}

function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function structuredLine(value: unknown, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return invalidOutput();
  const cleaned = cleanLine(value, maximum);
  if (!cleaned) return invalidOutput();
  return cleaned;
}

function structuredTimestamp(value: unknown): number {
  let timestamp: number;
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    timestamp = value < 1_000_000_000_000 ? value * 1_000 : value;
  } else if (typeof value === 'string') {
    timestamp = Date.parse(value);
  } else {
    return invalidOutput();
  }
  if (Number.isFinite(timestamp) && Number.isFinite(new Date(timestamp).getTime())) return timestamp;
  return invalidOutput();
}

function structuredTime(value: unknown): StatusPluginMenuTime | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !hasOnlyKeys(value, ['label', 'at'])) return invalidOutput();
  return withoutUndefined({
    label: structuredLine(value.label, STATUS_MENU_BADGE_MAX_LENGTH),
    at: structuredTimestamp(value.at),
  });
}

function structuredTone(value: unknown): StatusPluginTone | undefined {
  if (value === undefined) return undefined;
  if (value === 'neutral' || value === 'success' || value === 'warning' || value === 'danger') return value;
  return invalidOutput();
}

function structuredProgress(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100) return value;
  return invalidOutput();
}

function safeHref(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > STATUS_HREF_MAX_LENGTH) {
    return invalidOutput();
  }
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.toString();
  } catch {
    // Report the same bounded structured-output error below.
  }
  return invalidOutput();
}

function structuredMenuEntry(value: unknown): StatusPluginMenuEntry {
  if (!isRecord(value) || typeof value.type !== 'string') return invalidOutput();
  if (value.type === 'separator') {
    if (!hasOnlyKeys(value, ['type'])) return invalidOutput();
    return { type: 'separator' };
  }
  if (value.type === 'heading') {
    if (!hasOnlyKeys(value, ['type', 'text', 'badge'])) return invalidOutput();
    return withoutUndefined({
      type: 'heading',
      text: structuredLine(value.text, STATUS_TEXT_MAX_LENGTH)!,
      badge: structuredLine(value.badge, STATUS_MENU_BADGE_MAX_LENGTH),
    }) as StatusPluginMenuEntry;
  }
  if (
    value.type !== 'item' ||
    !hasOnlyKeys(value, [
      'type',
      'text',
      'value',
      'detail',
      'time',
      'badge',
      'checked',
      'progress',
      'tone',
      'href',
      'indent',
    ])
  )
    return invalidOutput();
  if (value.checked !== undefined && typeof value.checked !== 'boolean') return invalidOutput();
  if (
    value.indent !== undefined &&
    (!Number.isInteger(value.indent) || Number(value.indent) < 0 || Number(value.indent) > 3)
  )
    return invalidOutput();
  return withoutUndefined({
    type: 'item',
    text: structuredLine(value.text, STATUS_MENU_TEXT_MAX_LENGTH)!,
    value: structuredLine(value.value, STATUS_MENU_VALUE_MAX_LENGTH),
    detail: structuredLine(value.detail, STATUS_MENU_TEXT_MAX_LENGTH),
    time: structuredTime(value.time),
    badge: structuredLine(value.badge, STATUS_MENU_BADGE_MAX_LENGTH),
    checked: value.checked as boolean | undefined,
    progress: structuredProgress(value.progress),
    tone: structuredTone(value.tone),
    href: safeHref(value.href),
    indent: value.indent as number | undefined,
  }) as StatusPluginMenuEntry;
}

function structuredMenu(value: unknown): StatusPluginMenuEntry[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > STATUS_PLUGIN_MENU_MAX_ITEMS) return invalidOutput();
  const entries = value.map(structuredMenuEntry);
  return entries.length > 0 ? entries : undefined;
}

function compatibilityDetailMenu(value: unknown): StatusPluginMenuEntry[] | undefined {
  if (value === undefined) return undefined;
  const candidates = typeof value === 'string' ? value.split('\n') : value;
  if (!Array.isArray(candidates) || !candidates.every((line) => typeof line === 'string')) return invalidOutput();
  const entries = candidates
    .map((line) => cleanLine(line, STATUS_MENU_TEXT_MAX_LENGTH))
    .filter(Boolean)
    .slice(0, STATUS_PLUGIN_MENU_MAX_ITEMS)
    .map((text): StatusPluginMenuEntry => ({ type: 'item', text }));
  return entries.length > 0 ? entries : undefined;
}

function parseStructuredOutput(value: Record<string, unknown>): StatusPluginOutput {
  const text = structuredLine(value.text, STATUS_TEXT_MAX_LENGTH);
  if (!text) throw new TypeError('Status plugin command returned no output.');
  return withoutUndefined({
    text,
    tooltip: structuredLine(value.tooltip, STATUS_MENU_TEXT_MAX_LENGTH),
    menu: structuredMenu(value.menu) ?? compatibilityDetailMenu(value.detail),
    progress: structuredProgress(value.progress),
    tone: structuredTone(value.tone),
  });
}

function parameterMap(value: string): Map<string, string> {
  const parameters = new Map<string, string>();
  const pattern = /(?:^|\s)([a-zA-Z][\w-]*)=(?:"([^"]*)"|'([^']*)'|(\S+))/g;
  for (const match of value.matchAll(pattern)) {
    parameters.set(match[1]!.toLowerCase(), match[2] ?? match[3] ?? match[4] ?? '');
  }
  return parameters;
}

function booleanParameter(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value.toLowerCase() === 'true') return true;
  if (value.toLowerCase() === 'false') return false;
  return undefined;
}

function toneParameter(parameters: Map<string, string>): StatusPluginTone | undefined {
  const tone = parameters.get('tone')?.toLowerCase();
  if (tone === 'neutral' || tone === 'success' || tone === 'warning' || tone === 'danger') return tone;
  const color = parameters.get('color')?.toLowerCase();
  if (color === 'red') return 'danger';
  if (color === 'orange' || color === 'yellow') return 'warning';
  if (color === 'green') return 'success';
  return undefined;
}

function plainLine(value: string):
  | {
      text: string;
      parameters: Map<string, string>;
      indent: number;
    }
  | undefined {
  const delimiter = value.indexOf('|');
  let text = cleanLine(delimiter >= 0 ? value.slice(0, delimiter) : value, STATUS_MENU_TEXT_MAX_LENGTH);
  if (!text) return undefined;
  let indent = 0;
  while (indent < 3 && text.startsWith('--')) {
    indent += 1;
    text = text.slice(2).trimStart();
  }
  if (!text) return undefined;
  return {
    text,
    parameters: parameterMap(delimiter >= 0 ? value.slice(delimiter + 1) : ''),
    indent,
  };
}

function plainMenuItem(line: string): StatusPluginMenuEntry | undefined {
  const parsed = plainLine(line);
  if (!parsed) return undefined;
  const progressValue = Number(parsed.parameters.get('progress'));
  const progress =
    parsed.parameters.has('progress') && Number.isFinite(progressValue) && progressValue >= 0 && progressValue <= 100
      ? progressValue
      : undefined;
  let href: string | undefined;
  try {
    href = safeHref(parsed.parameters.get('href'));
  } catch {
    // Ignore invalid links in otherwise useful plain-text output.
  }
  return withoutUndefined({
    type: 'item',
    text: parsed.text,
    value: structuredLine(parsed.parameters.get('value'), STATUS_MENU_VALUE_MAX_LENGTH),
    detail: structuredLine(
      parsed.parameters.get('detail') ?? parsed.parameters.get('tooltip'),
      STATUS_MENU_TEXT_MAX_LENGTH
    ),
    badge: structuredLine(parsed.parameters.get('badge'), STATUS_MENU_BADGE_MAX_LENGTH),
    checked: booleanParameter(parsed.parameters.get('checked')),
    progress,
    tone: toneParameter(parsed.parameters),
    href,
    indent: parsed.indent || undefined,
  }) as StatusPluginMenuEntry;
}

function parsePlainOutput(cleaned: string): StatusPluginOutput {
  const lines = cleaned
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const header = plainLine(lines.shift() ?? '');
  if (!header) throw new TypeError('Status plugin command returned no output.');
  const menu: StatusPluginMenuEntry[] = [];
  let sawBodyBoundary = false;
  for (const line of lines) {
    if (line === '---') {
      if (!sawBodyBoundary) {
        sawBodyBoundary = true;
        continue;
      }
      if (menu.at(-1)?.type !== 'separator') menu.push({ type: 'separator' });
      continue;
    }
    const item = plainMenuItem(line);
    if (item) menu.push(item);
    if (menu.length >= STATUS_PLUGIN_MENU_MAX_ITEMS) break;
  }
  const progressValue = Number(header.parameters.get('progress'));
  return withoutUndefined({
    text: truncate(header.text, STATUS_TEXT_MAX_LENGTH),
    tooltip: structuredLine(header.parameters.get('tooltip'), STATUS_MENU_TEXT_MAX_LENGTH),
    menu: menu.length > 0 ? menu : undefined,
    progress:
      header.parameters.has('progress') && Number.isFinite(progressValue) && progressValue >= 0 && progressValue <= 100
        ? progressValue
        : undefined,
    tone: toneParameter(header.parameters),
  });
}

export function parseStatusPluginOutput(stdout: string): StatusPluginOutput {
  const cleaned = cleanText(stdout);
  if (!cleaned) throw new TypeError('Status plugin command returned no output.');

  if (cleaned.startsWith('{')) {
    try {
      const value: unknown = JSON.parse(cleaned);
      if (!isRecord(value)) return invalidOutput();
      return parseStructuredOutput(value);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      // A plain-text plugin may legitimately begin with a brace.
    }
  }

  return parsePlainOutput(cleaned);
}
