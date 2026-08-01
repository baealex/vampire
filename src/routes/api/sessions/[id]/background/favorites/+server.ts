import { error, json, type RequestHandler } from '@sveltejs/kit';
import { requireAuthentication } from '$lib/server/auth';
import {
	BACKGROUND_COMMAND_MAX_LENGTH,
	favoriteManagedBackgroundCommand,
	removeManagedBackgroundCommandFavorite,
	SessionMutationError
} from '$lib/server/session-registry';

async function readCommand(request: Request): Promise<string> {
	const body: unknown = await request.json().catch(() => undefined);
	const command = body && typeof body === 'object' && !Array.isArray(body) && 'command' in body
		? body.command
		: undefined;
	if (typeof command !== 'string' || !command.trim()) throw error(400, 'Background command is required.');
	if (command.length > BACKGROUND_COMMAND_MAX_LENGTH) {
		throw error(400, `Background command must be ${BACKGROUND_COMMAND_MAX_LENGTH.toLocaleString('en-US')} characters or fewer.`);
	}
	if (/[\0\r\n\t]/.test(command)) throw error(400, 'Background command must fit on one line.');
	return command;
}

function mutationError(cause: unknown): never {
	if (cause instanceof SessionMutationError) {
		throw error(cause.reason === 'not-found' ? 404 : cause.reason === 'invalid-background-command' ? 400 : 409, cause.message);
	}
	throw error(500, 'Vampire could not update favorite commands.');
}

export const POST: RequestHandler = async (event) => {
	requireAuthentication(event);
	const id = event.params.id;
	if (!id) throw error(400, 'Session ID is required.');
	const command = await readCommand(event.request);

	try {
		return json({ favoriteCommands: await favoriteManagedBackgroundCommand(id, command) });
	} catch (cause) {
		mutationError(cause);
	}
};

export const DELETE: RequestHandler = async (event) => {
	requireAuthentication(event);
	const id = event.params.id;
	if (!id) throw error(400, 'Session ID is required.');
	const command = await readCommand(event.request);

	try {
		return json({ favoriteCommands: await removeManagedBackgroundCommandFavorite(id, command) });
	} catch (cause) {
		mutationError(cause);
	}
};
