import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkspacePersistenceDocuments, parseWorkspacePersistenceDocuments } from './workspace-persistence.ts';
import type { WorkspaceStore } from './workspace-store.ts';

function state(): WorkspaceStore {
  return {
    version: 1,
    launchProfiles: [{ id: 'development', name: 'Development', command: 'pnpm dev' }],
    defaultStartupProfileId: 'development',
    workspacePreferences: { workspaceOrderMode: 'manual', manualWorkspaceOrder: ['workspace-1'] },
    workspaces: [
      {
        id: 'workspace-1',
        tmuxSession: 'vampire-workspace-1',
        cwd: '/projects/example',
        workspaceKind: 'directory',
        workspaceLabel: 'Example',
        createdAt: 10,
        lastActiveAt: 20,
        automations: [],
        favoriteCommands: ['pnpm dev'],
        startupProfileId: 'development',
        composerTemplate: '{{prompt}}',
      },
    ],
  };
}

test('round-trips registry, global, and workspace-owned state documents', () => {
  const documents = createWorkspacePersistenceDocuments(state(), 'revision-1');

  assert.deepEqual(parseWorkspacePersistenceDocuments(documents), state());
  assert.deepEqual(Object.keys(documents.registry.workspaces[0]!).sort(), [
    'createdAt',
    'cwd',
    'id',
    'lastActiveAt',
    'tmuxSession',
    'workspaceKind',
    'workspaceLabel',
  ]);
  assert.deepEqual(documents.workspaces[0]!.background.favoriteCommands, ['pnpm dev']);
});

test('rejects mixed revisions and orphaned workspace state', () => {
  const documents = createWorkspacePersistenceDocuments(state(), 'revision-1');
  documents.workspaces[0]!.automations.revision = 'revision-2';
  assert.throws(() => parseWorkspacePersistenceDocuments(documents), /revision/i);

  const withOrphan = createWorkspacePersistenceDocuments(state(), 'revision-1');
  withOrphan.registry.workspaces = [];
  assert.throws(() => parseWorkspacePersistenceDocuments(withOrphan), /absent from the registry/i);
});

test('rejects state stored in the wrong ownership document', () => {
  const documents = createWorkspacePersistenceDocuments(state(), 'revision-1');
  (documents.registry.workspaces[0] as Record<string, unknown>).favoriteCommands = ['pnpm dev'];

  assert.throws(() => parseWorkspacePersistenceDocuments(documents), /registry entry/i);
});
