import type { RequestHandler } from '~/lib/server/http-handler.server.ts';

type HttpMethod = 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT';

export type ServerRouteModule = Partial<Record<HttpMethod, RequestHandler>>;

export interface ServerRouteDefinition {
  load: () => Promise<ServerRouteModule>;
  path: string;
}

export const serverRouteManifest: readonly ServerRouteDefinition[] = [
  { path: '/api/automations', load: () => import('~/routes/api/automations/+server.ts') },
  { path: '/api/composer-history/settings', load: () => import('~/routes/api/composer-history/settings/+server.ts') },
  { path: '/api/launch-profiles', load: () => import('~/routes/api/launch-profiles/+server.ts') },
  { path: '/api/login', load: () => import('~/routes/api/login/+server.ts') },
  { path: '/api/status-plugins', load: () => import('~/routes/api/status-plugins/+server.ts') },
  { path: '/api/status', load: () => import('~/routes/api/status/+server.ts') },
  { path: '/api/system', load: () => import('~/routes/api/system/+server.ts') },
  { path: '/api/system/ports', load: () => import('~/routes/api/system/ports/+server.ts') },
  { path: '/api/system/ports/:pid', load: () => import('~/routes/api/system/ports/[pid]/+server.ts') },
  { path: '/api/terminal-input/settings', load: () => import('~/routes/api/terminal-input/settings/+server.ts') },
  { path: '/api/workspace-directories', load: () => import('~/routes/api/workspace-directories/+server.ts') },
  { path: '/api/workspace-preferences', load: () => import('~/routes/api/workspace-preferences/+server.ts') },
  { path: '/api/workspaces', load: () => import('~/routes/api/workspaces/+server.ts') },
  { path: '/api/workspaces/:id', load: () => import('~/routes/api/workspaces/[id]/+server.ts') },
  {
    path: '/api/workspaces/:id/agent-actions/:actionId',
    load: () => import('~/routes/api/workspaces/[id]/agent-actions/[actionId]/+server.ts'),
  },
  { path: '/api/workspaces/:id/alias', load: () => import('~/routes/api/workspaces/[id]/alias/+server.ts') },
  {
    path: '/api/workspaces/:id/automations',
    load: () => import('~/routes/api/workspaces/[id]/automations/+server.ts'),
  },
  {
    path: '/api/workspaces/:id/automations/:automationId',
    load: () => import('~/routes/api/workspaces/[id]/automations/[automationId]/+server.ts'),
  },
  { path: '/api/workspaces/:id/background', load: () => import('~/routes/api/workspaces/[id]/background/+server.ts') },
  {
    path: '/api/workspaces/:id/background/:processId',
    load: () => import('~/routes/api/workspaces/[id]/background/[processId]/+server.ts'),
  },
  {
    path: '/api/workspaces/:id/background/:processId/output',
    load: () => import('~/routes/api/workspaces/[id]/background/[processId]/output/+server.ts'),
  },
  {
    path: '/api/workspaces/:id/background/favorites',
    load: () => import('~/routes/api/workspaces/[id]/background/favorites/+server.ts'),
  },
  { path: '/api/workspaces/:id/close', load: () => import('~/routes/api/workspaces/[id]/close/+server.ts') },
  {
    path: '/api/workspaces/:id/composer-prompts',
    load: () => import('~/routes/api/workspaces/[id]/composer-prompts/+server.ts'),
  },
  { path: '/api/workspaces/:id/note', load: () => import('~/routes/api/workspaces/[id]/note/+server.ts') },
  { path: '/api/workspaces/:id/note/agent', load: () => import('~/routes/api/workspaces/[id]/note/agent/+server.ts') },
  { path: '/api/workspaces/:id/repository', load: () => import('~/routes/api/workspaces/[id]/repository/+server.ts') },
  {
    path: '/api/workspaces/:id/repository/branch',
    load: () => import('~/routes/api/workspaces/[id]/repository/branch/+server.ts'),
  },
  {
    path: '/api/workspaces/:id/repository/commit',
    load: () => import('~/routes/api/workspaces/[id]/repository/commit/+server.ts'),
  },
  {
    path: '/api/workspaces/:id/repository/commits',
    load: () => import('~/routes/api/workspaces/[id]/repository/commits/+server.ts'),
  },
  {
    path: '/api/workspaces/:id/repository/copy',
    load: () => import('~/routes/api/workspaces/[id]/repository/copy/+server.ts'),
  },
  {
    path: '/api/workspaces/:id/repository/diff',
    load: () => import('~/routes/api/workspaces/[id]/repository/diff/+server.ts'),
  },
  {
    path: '/api/workspaces/:id/repository/directory',
    load: () => import('~/routes/api/workspaces/[id]/repository/directory/+server.ts'),
  },
  {
    path: '/api/workspaces/:id/repository/discard',
    load: () => import('~/routes/api/workspaces/[id]/repository/discard/+server.ts'),
  },
  {
    path: '/api/workspaces/:id/repository/file',
    load: () => import('~/routes/api/workspaces/[id]/repository/file/+server.ts'),
  },
  {
    path: '/api/workspaces/:id/repository/media',
    load: () => import('~/routes/api/workspaces/[id]/repository/media/+server.ts'),
  },
  {
    path: '/api/workspaces/:id/repository/move',
    load: () => import('~/routes/api/workspaces/[id]/repository/move/+server.ts'),
  },
  { path: '/api/workspaces/:id/settings', load: () => import('~/routes/api/workspaces/[id]/settings/+server.ts') },
  {
    path: '/api/workspaces/:id/startup-profile',
    load: () => import('~/routes/api/workspaces/[id]/startup-profile/+server.ts'),
  },
  { path: '/api/workspaces/:id/worktrees', load: () => import('~/routes/api/workspaces/[id]/worktrees/+server.ts') },
];
