import type { WorkspaceEntryKind } from '@vampire/lib/shared/contracts/repository.ts';

export type RepositoryEntry = { kind: WorkspaceEntryKind; path: string };

export type RepositoryFileCategory = 'audio' | 'code' | 'document' | 'file' | 'image' | 'video';

const FILE_EXTENSIONS_BY_CATEGORY: Readonly<Record<Exclude<RepositoryFileCategory, 'file'>, ReadonlySet<string>>> = {
  audio: new Set(['aac', 'flac', 'm4a', 'mp3', 'oga', 'ogg', 'opus', 'wav', 'wma']),
  code: new Set([
    'bash',
    'c',
    'cc',
    'cjs',
    'clj',
    'cljs',
    'cpp',
    'cs',
    'css',
    'cxx',
    'dart',
    'ex',
    'exs',
    'fish',
    'fs',
    'fsx',
    'go',
    'graphql',
    'h',
    'hpp',
    'htm',
    'html',
    'java',
    'js',
    'json',
    'jsonc',
    'jsx',
    'kt',
    'kts',
    'less',
    'lua',
    'mjs',
    'php',
    'py',
    'r',
    'rb',
    'rs',
    'sass',
    'scala',
    'scss',
    'sh',
    'sql',
    'svelte',
    'swift',
    'toml',
    'ts',
    'tsx',
    'vue',
    'xml',
    'yaml',
    'yml',
    'zsh',
  ]),
  document: new Set([
    'adoc',
    'csv',
    'doc',
    'docx',
    'epub',
    'key',
    'log',
    'md',
    'mdx',
    'numbers',
    'ods',
    'odt',
    'pages',
    'pdf',
    'ppt',
    'pptx',
    'rst',
    'rtf',
    'tex',
    'tsv',
    'txt',
    'xls',
    'xlsx',
  ]),
  image: new Set(['avif', 'bmp', 'gif', 'ico', 'jpeg', 'jpg', 'png', 'svg', 'tif', 'tiff', 'webp']),
  video: new Set(['avi', 'm4v', 'mkv', 'mov', 'mp4', 'mpeg', 'mpg', 'ogv', 'webm', 'wmv']),
};

const CODE_FILE_NAMES = new Set([
  '.dockerignore',
  '.editorconfig',
  '.gitattributes',
  '.gitignore',
  '.npmrc',
  'dockerfile',
  'gemfile',
  'justfile',
  'makefile',
  'procfile',
  'rakefile',
  'vagrantfile',
]);

const DOCUMENT_FILE_NAMES = new Set(['authors', 'changelog', 'contributing', 'license', 'notice', 'readme']);

export function repositoryFileCategory(path: string): RepositoryFileCategory {
  const name = repositoryBasename(path).toLowerCase();
  if (CODE_FILE_NAMES.has(name)) return 'code';
  if (DOCUMENT_FILE_NAMES.has(name)) return 'document';
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  if (!extension) return 'file';
  for (const category of ['image', 'audio', 'video', 'document', 'code'] as const) {
    if (FILE_EXTENSIONS_BY_CATEGORY[category].has(extension)) return category;
  }
  return 'file';
}

export function repositoryParentPath(path: string) {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

export function repositoryBasename(path: string) {
  return path.slice(path.lastIndexOf('/') + 1);
}
