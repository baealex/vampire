import { error, json, type RequestHandler } from '@sveltejs/kit';
import { requireAuthentication } from '$lib/server/auth';
import { readWorkspaceDirectory, WorkspaceRootError } from '$lib/server/workspace-roots.ts';

function errorStatus(reason: WorkspaceRootError['reason']): number {
	if (reason === 'outside-root') return 403;
	if (reason === 'not-found') return 404;
	if (reason === 'unreadable') return 403;
	return 400;
}

export const GET: RequestHandler = async (event) => {
	requireAuthentication(event);
	const path = event.url.searchParams.get('path') ?? undefined;

	try {
		return json(await readWorkspaceDirectory(path));
	} catch (cause) {
		if (cause instanceof WorkspaceRootError) throw error(errorStatus(cause.reason), cause.message);
		throw error(500, 'Unable to read workspace directories.');
	}
};
