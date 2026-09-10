import { readdir, readFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';

type Layer =
  | { kind: 'shared' }
  | { kind: 'app' }
  | { kind: 'feature'; name: string; segment?: string }
  | { kind: 'widget'; name: string };

interface ImportReference {
  line: number;
  specifier: string;
}

export interface ArchitectureViolation {
  line: number;
  reason: string;
  source: string;
  specifier: string;
  target: string;
}

const SOURCE_EXTENSIONS = new Set(['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx']);
const RESOLUTION_EXTENSIONS = ['', '.cjs', '.css', '.js', '.jsx', '.md', '.mjs', '.ts', '.tsx'];

function posixPath(path: string): string {
  return path.split(sep).join('/');
}

function relativePath(repositoryRoot: string, path: string): string {
  return posixPath(relative(repositoryRoot, path));
}

function isTestFile(path: string): boolean {
  return /\.(?:component\.)?test\.tsx?$/.test(path);
}

function isServerOnlyModule(repositoryRoot: string, path: string): boolean {
  const pathFromRoot = relativePath(repositoryRoot, path);
  if (pathFromRoot.startsWith('src/lib/server/')) return true;

  const filename = pathFromRoot.split('/').at(-1) ?? '';
  return filename.startsWith('+server.') || filename.includes('.server.');
}

function requiresServerOnlyFilename(repositoryRoot: string, path: string): boolean {
  const segments = relativePath(repositoryRoot, path).split('/');
  const inAppServer =
    segments[0] === 'src' && segments[1] === 'lib' && segments[2] === 'app' && segments[3] === 'server';
  const inFeatureServer =
    segments[0] === 'src' &&
    segments[1] === 'lib' &&
    segments[2] === 'features' &&
    Boolean(segments[3]) &&
    segments[4] === 'server';
  return (inAppServer || inFeatureServer) && !isServerOnlyModule(repositoryRoot, path);
}

async function collectFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true }).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === 'ENOENT') return [];
    throw cause;
  });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(path)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

function layerFor(repositoryRoot: string, path: string): Layer | undefined {
  const pathFromRoot = relativePath(repositoryRoot, path);
  const rawSegments = pathFromRoot.split('/');
  const segments =
    rawSegments[0] === 'src' && rawSegments[1] === 'lib'
      ? rawSegments.slice(2)
      : rawSegments[0] === 'packages' && rawSegments[1] === 'client' && rawSegments[2] === 'src'
        ? rawSegments.slice(3)
        : [];

  if (segments[0] === 'shared') return { kind: 'shared' };
  if (segments[0] === 'app') return { kind: 'app' };
  if (segments[0] === 'features' && segments[1]) {
    return { kind: 'feature', name: segments[1], segment: segments[2] };
  }
  if (segments[0] === 'widgets' && segments[1]) return { kind: 'widget', name: segments[1] };
  return undefined;
}

function importedModules(source: string): ImportReference[] {
  const references: ImportReference[] = [];
  const addMatches = (pattern: RegExp): void => {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (!specifier || match.index === undefined) continue;
      references.push({
        line: source.slice(0, match.index).split('\n').length,
        specifier,
      });
    }
  };

  addMatches(/\b(?:import|export)\s+(?:type\s+)?(?:(?:[\s\S]*?)\s+from\s+)?['"]([^'"]+)['"]/g);
  addMatches(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g);

  return references;
}

function resolveImport(
  repositoryRoot: string,
  sourcePath: string,
  specifier: string,
  knownFiles: Set<string>,
): string | undefined {
  const cleanSpecifier = specifier.split(/[?#]/, 1)[0];
  let basePath: string;
  if (cleanSpecifier.startsWith('~/')) {
    const clientSource = relativePath(repositoryRoot, sourcePath).startsWith('packages/client/src/');
    basePath = clientSource
      ? cleanSpecifier.startsWith('~/lib/')
        ? resolve(repositoryRoot, 'src', 'lib', cleanSpecifier.slice('~/lib/'.length))
        : resolve(repositoryRoot, 'packages', 'client', 'src', cleanSpecifier.slice(2))
      : resolve(repositoryRoot, 'src', cleanSpecifier.slice(2));
  } else if (cleanSpecifier.startsWith('@vampire/')) {
    basePath = resolve(repositoryRoot, 'src', cleanSpecifier.slice('@vampire/'.length));
  } else if (cleanSpecifier.startsWith('$lib/')) {
    basePath = resolve(repositoryRoot, 'src', 'lib', cleanSpecifier.slice('$lib/'.length));
  } else if (cleanSpecifier.startsWith('.')) {
    basePath = resolve(dirname(sourcePath), cleanSpecifier);
  } else {
    return undefined;
  }

  const candidates = RESOLUTION_EXTENSIONS.flatMap((extension) => [
    `${basePath}${extension}`,
    join(basePath, `index${extension}`),
  ]);
  return candidates.find((candidate) => knownFiles.has(candidate));
}

function violationReason(source: Layer, target: Layer): string | undefined {
  if (source.kind === 'shared' && target.kind !== 'shared') {
    return 'shared must not depend on app, widgets, or features';
  }

  if (source.kind === 'feature') {
    if (target.kind === 'app' || target.kind === 'widget') {
      return `feature:${source.name} must not depend on ${target.kind}`;
    }
    if (target.kind === 'feature' && target.name !== source.name) {
      return `feature:${source.name} must not depend on peer feature:${target.name}`;
    }
    if (source.segment === 'server' && target.kind === 'feature' && target.segment === 'ui') {
      return `feature:${source.name}/server must not depend on feature UI`;
    }
  }

  if (source.kind === 'widget') {
    if (target.kind === 'app') return `widget:${source.name} must not depend on app`;
    if (target.kind === 'widget' && target.name !== source.name) {
      return `widget:${source.name} must not depend on peer widget:${target.name}`;
    }
  }

  return undefined;
}

export async function findArchitectureViolations(
  repositoryRoot = resolve(import.meta.dirname, '..'),
): Promise<ArchitectureViolation[]> {
  const sourceRoots = [resolve(repositoryRoot, 'src'), resolve(repositoryRoot, 'packages', 'client', 'src')];
  const allFiles = (await Promise.all(sourceRoots.map((sourceRoot) => collectFiles(sourceRoot)))).flat();
  const knownFiles = new Set(allFiles);
  const sourceFiles = allFiles.filter((path) => SOURCE_EXTENSIONS.has(extname(path)) && !isTestFile(path));
  const violations: ArchitectureViolation[] = [];

  for (const sourcePath of sourceFiles) {
    if (requiresServerOnlyFilename(repositoryRoot, sourcePath)) {
      violations.push({
        line: 1,
        reason: 'production modules in app/server and feature/server must use a *.server.* filename',
        source: relativePath(repositoryRoot, sourcePath),
        specifier: '',
        target: '',
      });
    }

    const sourceLayer = layerFor(repositoryRoot, sourcePath);
    const source = await readFile(sourcePath, 'utf8');
    for (const reference of importedModules(source)) {
      if (reference.specifier === '@baejino/react-ui' && sourceLayer?.kind !== 'shared') {
        violations.push({
          line: reference.line,
          reason: '@baejino/react-ui must be accessed through shared/ui primitives',
          source: relativePath(repositoryRoot, sourcePath),
          specifier: reference.specifier,
          target: 'external package',
        });
        continue;
      }
      const targetPath = resolveImport(repositoryRoot, sourcePath, reference.specifier, knownFiles);
      if (!targetPath) continue;

      if (!isServerOnlyModule(repositoryRoot, sourcePath) && isServerOnlyModule(repositoryRoot, targetPath)) {
        violations.push({
          line: reference.line,
          reason: 'browser-capable modules must not depend on server-only modules',
          source: relativePath(repositoryRoot, sourcePath),
          specifier: reference.specifier,
          target: relativePath(repositoryRoot, targetPath),
        });
        continue;
      }

      if (!sourceLayer) continue;
      const targetLayer = layerFor(repositoryRoot, targetPath);
      if (!targetLayer) continue;
      const reason = violationReason(sourceLayer, targetLayer);
      if (!reason) continue;
      violations.push({
        line: reference.line,
        reason,
        source: relativePath(repositoryRoot, sourcePath),
        specifier: reference.specifier,
        target: relativePath(repositoryRoot, targetPath),
      });
    }
  }

  return violations.sort((left, right) =>
    `${left.source}:${left.line}:${left.specifier}`.localeCompare(`${right.source}:${right.line}:${right.specifier}`),
  );
}
