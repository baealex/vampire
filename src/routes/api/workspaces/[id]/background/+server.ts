import { error, json, type RequestHandler } from '@sveltejs/kit';
import { requireAuthentication } from '~/lib/features/auth/server/auth';
import {
  BACKGROUND_COMMAND_MAX_LENGTH,
  createManagedBackgroundProcess,
  WorkspaceMutationError,
} from '~/lib/features/workspace/server/workspace-registry';

export const POST: RequestHandler = async (event) => {
  requireAuthentication(event);
  const id = event.params.id;
  if (!id) throw error(400, 'Workspace ID is required.');

  const body: unknown = await event.request.json().catch(() => undefined);
  const command =
    body && typeof body === 'object' && !Array.isArray(body) && 'command' in body ? body.command : undefined;
  if (typeof command !== 'string' || !command.trim()) throw error(400, 'Background command is required.');
  if (command.length > BACKGROUND_COMMAND_MAX_LENGTH) {
    throw error(
      400,
      `Background command must be ${BACKGROUND_COMMAND_MAX_LENGTH.toLocaleString('en-US')} characters or fewer.`
    );
  }
  if (/[\0\r\n\t]/.test(command)) throw error(400, 'Background command must fit on one line.');

  try {
    return json({ backgroundProcess: await createManagedBackgroundProcess(id, command) }, { status: 201 });
  } catch (cause) {
    if (cause instanceof WorkspaceMutationError) {
      throw error(
        cause.reason === 'not-found' ? 404 : cause.reason === 'invalid-background-command' ? 400 : 409,
        cause.message
      );
    }
    throw error(500, 'Vampire could not start the background command.');
  }
};
