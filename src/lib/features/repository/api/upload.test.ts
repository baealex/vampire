import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dataTransferHasUploadFiles,
  uploadSelectionFromFiles,
  WorkspaceUploadSelectionError,
  workspaceUploadPath,
} from '~/lib/features/repository/api/upload.ts';

test('recognizes external files even when a browser omits the Files transfer type', () => {
  assert.equal(
    dataTransferHasUploadFiles({ types: [], items: [{ kind: 'file' }], files: [] } as unknown as DataTransfer),
    true
  );
});

function fileWithRelativePath(name: string, relativePath: string, content = name): File {
  const file = new File([content], name);
  Object.defineProperty(file, 'webkitRelativePath', { value: relativePath });
  return file;
}

test('preserves selected folder paths and skips git metadata', () => {
  const selection = uploadSelectionFromFiles([
    fileWithRelativePath('index.ts', 'sample/src/index.ts'),
    fileWithRelativePath('config', 'sample/.GIT/config'),
  ]);
  assert.deepEqual(
    selection.candidates.map(({ relativePath }) => relativePath),
    ['sample/src/index.ts']
  );
  assert.equal(selection.skippedGitFiles, 1);
  assert.equal(workspaceUploadPath('packages', selection.candidates[0]!.relativePath), 'packages/sample/src/index.ts');
});

test('rejects traversal and selections containing only git metadata', () => {
  assert.throws(
    () => workspaceUploadPath('', '../secret.txt'),
    (error) => error instanceof WorkspaceUploadSelectionError
  );
  assert.throws(
    () => uploadSelectionFromFiles([fileWithRelativePath('config', '.git/config')]),
    (error) => error instanceof WorkspaceUploadSelectionError && error.message === 'Git metadata cannot be added.'
  );
});
