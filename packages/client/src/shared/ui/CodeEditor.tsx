import Editor, { loader, type Monaco } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import cssWorker from 'monaco-editor/language/css/css.worker.js?worker';
import htmlWorker from 'monaco-editor/language/html/html.worker.js?worker';
import jsonWorker from 'monaco-editor/language/json/json.worker.js?worker';
import tsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker';
import { useEffect, useMemo } from 'react';
import { cssToken, terminalFontFamily, useTheme } from '../theme/theme.ts';
import { PanelState } from './PanelState.tsx';

type MonacoWorkerEnvironment = typeof globalThis & {
  MonacoEnvironment?: {
    getWorker(moduleId: string, label: string): Worker;
  };
};

(globalThis as MonacoWorkerEnvironment).MonacoEnvironment = {
  getWorker(_moduleId, label) {
    if (label === 'json') return new jsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker();
    if (label === 'typescript' || label === 'javascript') return new tsWorker();
    return new editorWorker();
  },
};

loader.config({ monaco });

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  bash: 'shell',
  c: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  css: 'css',
  go: 'go',
  h: 'cpp',
  hpp: 'cpp',
  html: 'html',
  java: 'java',
  js: 'javascript',
  json: 'json',
  jsonc: 'json',
  jsx: 'javascript',
  md: 'markdown',
  mjs: 'javascript',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  scss: 'scss',
  sh: 'shell',
  sql: 'sql',
  svelte: 'html',
  toml: 'ini',
  ts: 'typescript',
  tsx: 'typescript',
  vue: 'html',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  zsh: 'shell',
};

function languageForPath(path?: string) {
  const name = path?.split('/').at(-1)?.toLowerCase();
  if (!name) return 'plaintext';
  if (name === 'dockerfile') return 'dockerfile';
  if (name === 'makefile') return 'makefile';
  const extension = name.includes('.') ? name.split('.').at(-1) : undefined;
  return (extension && LANGUAGE_BY_EXTENSION[extension]) || 'plaintext';
}

function defineThemes(instance: Monaco) {
  const background = cssToken('--color-code-background');
  instance.editor.defineTheme('vampire-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': background,
      'editorGutter.background': background,
    },
  });
  instance.editor.defineTheme('vampire-light', {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': background,
      'editorGutter.background': background,
    },
  });
}

export function CodeEditor({
  label,
  language,
  onChange,
  path,
  value,
}: {
  label: string;
  language?: string;
  onChange: (value: string) => void;
  path?: string;
  value: string;
}) {
  const theme = useTheme((state) => state.current);
  useEffect(() => defineThemes(monaco), [theme]);
  const options = useMemo(
    () => ({
      ariaLabel: label,
      automaticLayout: true,
      bracketPairColorization: { enabled: true },
      folding: true,
      fontFamily: terminalFontFamily(),
      fontSize: 13,
      formatOnPaste: false,
      glyphMargin: false,
      lineHeight: 20,
      lineNumbers: 'on' as const,
      minimap: { enabled: false },
      overviewRulerBorder: false,
      padding: { top: 10, bottom: 10 },
      renderLineHighlight: 'line' as const,
      roundedSelection: false,
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      tabSize: 2,
      wordWrap: 'on' as const,
    }),
    [label],
  );
  return (
    <div className="vampire-code-editor">
      <Editor
        beforeMount={defineThemes}
        language={language ?? languageForPath(path)}
        loading={<PanelState loading>Loading editor…</PanelState>}
        onChange={(next) => onChange(next ?? '')}
        options={options}
        theme={theme === 'dark' ? 'vampire-dark' : 'vampire-light'}
        value={value}
      />
    </div>
  );
}
