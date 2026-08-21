import { error, json, type RequestHandler } from '@sveltejs/kit';
import { requireAuthentication } from '~/lib/features/auth/server/auth';
import {
  createManagedWorkspaceAutomation,
  listManagedWorkspaceAutomations,
  WorkspaceAutomationMutationError,
} from '~/lib/features/workspace/server/workspace-automations';

function automationError(cause: WorkspaceAutomationMutationError): never {
  throw error(
    cause.reason === 'not-found' || cause.reason === 'automation-not-found'
      ? 404
      : cause.reason === 'limit'
        ? 409
        : 400,
    cause.message
  );
}

export const GET: RequestHandler = async (event) => {
  requireAuthentication(event);
  const id = event.params.id;
  if (!id) throw error(400, 'Workspace ID is required.');
  try {
    return json(
      { automations: await listManagedWorkspaceAutomations(id) },
      { headers: { 'cache-control': 'no-store' } }
    );
  } catch (cause) {
    if (cause instanceof WorkspaceAutomationMutationError) automationError(cause);
    throw error(500, 'Vampire could not load workspace automations.');
  }
};
export const POST: RequestHandler = async (event) => {
  requireAuthentication(event);
  const id = event.params.id;
  if (!id) throw error(400, 'Workspace ID is required.');
  const body: unknown = await event.request.json().catch(() => undefined);
  try {
    return json({ automation: await createManagedWorkspaceAutomation(id, body) }, { status: 201 });
  } catch (cause) {
    if (cause instanceof WorkspaceAutomationMutationError) automationError(cause);
    throw error(500, 'Vampire could not save the workspace automation.');
  }
};
