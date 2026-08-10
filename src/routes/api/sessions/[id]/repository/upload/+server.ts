import { error, json, type RequestHandler } from '@sveltejs/kit';
import { requireAuthentication } from '$lib/server/auth';
import { RepositoryReadError, uploadWorkspaceFile } from '$lib/server/repository.ts';
import { findManagedWorkspace } from '$lib/server/session-registry';
import type { WorkspaceUploadConflict } from '$lib/repository/types';

const UPLOAD_CONFLICT_POLICIES = new Set<WorkspaceUploadConflict>(['reject', 'overwrite', 'rename']);

function repositoryErrorStatus(reason: string): number {
	if (reason === 'conflict') return 409;
	if (reason === 'invalid-path') return 400;
	if (reason === 'not-found') return 404;
	if (reason === 'too-large') return 413;
	if (reason === 'unsupported-file') return 415;
	return 503;
}

export const POST: RequestHandler = async (event) => {
	requireAuthentication(event);
	const id = event.params.id;
	if (!id) throw error(400, 'Session ID is required.');

	const workspace = await findManagedWorkspace(id);
	if (!workspace) throw error(404, 'Workspace was not found.');

	const path = event.url.searchParams.get('path');
	if (!path) throw error(400, 'File path is required.');
	const conflictValue = event.url.searchParams.get('conflict') ?? 'reject';
	if (!UPLOAD_CONFLICT_POLICIES.has(conflictValue as WorkspaceUploadConflict)) {
		throw error(400, 'Upload conflict policy is invalid.');
	}

	try {
		const result = await uploadWorkspaceFile(
			workspace.cwd,
			path,
			event.request.body ?? new Uint8Array(),
			{ conflict: conflictValue as WorkspaceUploadConflict }
		);
		return json(result, { status: 201 });
	} catch (cause) {
		if (cause instanceof RepositoryReadError) throw error(repositoryErrorStatus(cause.reason), cause.message);
		throw error(500, 'Vampire could not add this file.');
	}
};
