import { error, json, type RequestHandler } from '@sveltejs/kit';
import { requireAuthentication } from '$lib/server/auth';
import { deleteWorkspaceEntry, readWorkspaceFile, RepositoryReadError, writeWorkspaceFile } from '$lib/server/repository.mjs';
import { findManagedWorkspace } from '$lib/server/session-registry';

function repositoryErrorStatus(reason: string): number {
	if (reason === 'conflict') return 409;
	if (reason === 'invalid-path') return 400;
	if (reason === 'not-found') return 404;
	if (reason === 'too-large') return 413;
	if (reason === 'unsupported-file') return 415;
	return 503;
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
	try {
		const body: unknown = await request.json();
		if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid-body');
		return body as Record<string, unknown>;
	} catch {
		throw error(400, 'File data is invalid.');
	}
}

async function findWorkspace(id: string) {
	const workspace = await findManagedWorkspace(id);
	if (!workspace) throw error(404, 'Workspace was not found.');
	return workspace;
}

export const GET: RequestHandler = async (event) => {
	requireAuthentication(event);
	const id = event.params.id;
	if (!id) throw error(400, 'Session ID is required.');
	const path = event.url.searchParams.get('path');
	if (!path) throw error(400, 'File path is required.');

	const workspace = await findWorkspace(id);

	try {
		return json(await readWorkspaceFile(workspace.cwd, path));
	} catch (cause) {
		if (cause instanceof RepositoryReadError) throw error(repositoryErrorStatus(cause.reason), cause.message);
		throw error(500, 'Vampire could not read this file.');
	}
};

export const PUT: RequestHandler = async (event) => {
	requireAuthentication(event);
	const id = event.params.id;
	if (!id) throw error(400, 'Session ID is required.');
	const path = event.url.searchParams.get('path');
	if (!path) throw error(400, 'File path is required.');
	const body = await readJsonBody(event.request);
	if (typeof body.content !== 'string') throw error(400, 'File content is required.');
	if (body.version !== undefined && typeof body.version !== 'string') throw error(400, 'File version is invalid.');

	const workspace = await findWorkspace(id);
	try {
		return json(await writeWorkspaceFile(workspace.cwd, path, body.content, {
			expectedVersion: body.version as string | undefined
		}));
	} catch (cause) {
		if (cause instanceof RepositoryReadError) throw error(repositoryErrorStatus(cause.reason), cause.message);
		throw error(500, 'Vampire could not save this file.');
	}
};

export const POST: RequestHandler = async (event) => {
	requireAuthentication(event);
	const id = event.params.id;
	if (!id) throw error(400, 'Session ID is required.');
	const body = await readJsonBody(event.request);
	if (typeof body.path !== 'string' || !body.path) throw error(400, 'File path is required.');
	if (typeof body.content !== 'string') throw error(400, 'File content is required.');

	const workspace = await findWorkspace(id);
	try {
		return json(await writeWorkspaceFile(workspace.cwd, body.path, body.content, { createOnly: true }), { status: 201 });
	} catch (cause) {
		if (cause instanceof RepositoryReadError) throw error(repositoryErrorStatus(cause.reason), cause.message);
		throw error(500, 'Vampire could not create this file.');
	}
};

export const DELETE: RequestHandler = async (event) => {
	requireAuthentication(event);
	const id = event.params.id;
	if (!id) throw error(400, 'Session ID is required.');
	const path = event.url.searchParams.get('path');
	if (!path) throw error(400, 'File path is required.');

	const workspace = await findWorkspace(id);
	try {
		return json(await deleteWorkspaceEntry(workspace.cwd, path, 'file'));
	} catch (cause) {
		if (cause instanceof RepositoryReadError) throw error(repositoryErrorStatus(cause.reason), cause.message);
		throw error(500, 'Vampire could not delete this file.');
	}
};
