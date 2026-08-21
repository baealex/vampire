import type { DiffLine, FileTreeRow, RepositoryChange } from '~/lib/shared/contracts/repository';

export type FileChangeKind = 'added' | 'modified';

type FileTreeNode = {
  kind: 'directory' | 'file';
  name: string;
  path: string;
  children: Map<string, FileTreeNode>;
};

const PREVIEWABLE_IMAGE_EXTENSIONS = new Set(['avif', 'gif', 'jpeg', 'jpg', 'png', 'webp']);

export function isPreviewableImage(path: string): boolean {
  const extension = path.split('.').pop()?.toLowerCase();
  return Boolean(extension && PREVIEWABLE_IMAGE_EXTENSIONS.has(extension));
}

export function buildVisibleFileTree(
  files: string[],
  expandedDirectories: string[],
  directories: string[] = []
): FileTreeRow[] {
  const root: FileTreeNode = { kind: 'directory', name: '', path: '', children: new Map() };
  const directoryPaths = new Set(directories);
  for (const path of [...directories, ...files]) {
    const parts = path.split('/').filter(Boolean);
    let parent = root;
    for (let index = 0; index < parts.length; index += 1) {
      const name = parts[index];
      const nodePath = parts.slice(0, index + 1).join('/');
      const kind = directoryPaths.has(path) || index < parts.length - 1 ? 'directory' : 'file';
      let child = parent.children.get(name);
      if (!child) {
        child = { kind, name, path: nodePath, children: new Map() };
        parent.children.set(name, child);
      }
      parent = child;
    }
  }

  const expanded = new Set(expandedDirectories);
  const rows: FileTreeRow[] = [];
  function appendChildren(node: FileTreeNode, depth: number) {
    const children = [...node.children.values()].sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1;
      return left.name.localeCompare(right.name, 'en');
    });
    for (const child of children) {
      rows.push({ kind: child.kind, name: child.name, path: child.path, depth });
      if (child.kind === 'directory' && expanded.has(child.path)) appendChildren(child, depth + 1);
    }
  }
  appendChildren(root, 0);
  return rows;
}

function statusName(status: string): string {
  if (status === '?') return 'untracked';
  if (status === 'A') return 'added';
  if (status === 'D') return 'deleted';
  if (status === 'R') return 'renamed';
  if (status === 'C') return 'copied';
  if (status === 'T') return 'type changed';
  if (status === 'U') return 'conflicted';
  return 'modified';
}

export function changeBadge(change: RepositoryChange): string {
  if (change.status === '??') return 'U';
  const status = change.status[1] !== ' ' ? change.status[1] : change.status[0];
  return status === '?' ? 'U' : status;
}

export function fileChangeKind(change?: RepositoryChange): FileChangeKind | undefined {
  if (!change) return undefined;
  if (change.status === '??' || change.status.includes('A') || change.status.includes('?')) return 'added';
  return 'modified';
}

export function buildChangeKindMap(changes: RepositoryChange[]): Map<string, FileChangeKind> {
  const kinds = new Map<string, FileChangeKind>();
  for (const change of changes) {
    const kind = fileChangeKind(change);
    if (!kind) continue;
    const parts = change.path.split('/').filter(Boolean);
    for (let index = 1; index <= parts.length; index += 1) {
      const path = parts.slice(0, index).join('/');
      const current = kinds.get(path);
      if (!current || (current === 'added' && kind === 'modified')) kinds.set(path, kind);
    }
  }
  return kinds;
}

export function describeChange(change: RepositoryChange): string {
  if (change.status === '??') return 'Untracked';
  const states: string[] = [];
  if (change.status[0] !== ' ') states.push(`Staged ${statusName(change.status[0])}`);
  if (change.status[1] !== ' ') states.push(`Working tree ${statusName(change.status[1])}`);
  return states.join(' · ');
}

export function parseDiffLines(patch: string): DiffLine[] {
  let oldLine: number | undefined;
  let newLine: number | undefined;
  return patch.split('\n').map((content) => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(content);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      return { kind: 'hunk', content };
    }
    if (content.startsWith('+') && !content.startsWith('+++')) {
      const line = { kind: 'addition' as const, content, newLine };
      if (newLine !== undefined) newLine += 1;
      return line;
    }
    if (content.startsWith('-') && !content.startsWith('---')) {
      const line = { kind: 'deletion' as const, content, oldLine };
      if (oldLine !== undefined) oldLine += 1;
      return line;
    }
    if (content.startsWith(' ') && oldLine !== undefined && newLine !== undefined) {
      const line = { kind: 'context' as const, content, oldLine, newLine };
      oldLine += 1;
      newLine += 1;
      return line;
    }
    return { kind: 'meta', content };
  });
}
