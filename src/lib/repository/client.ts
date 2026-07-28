import { requestJson, requestResponse } from '$lib/client/request';
import type {
	RepositoryDiff,
	RepositoryDirectoryListing,
	RepositorySnapshot,
	WorkspaceFile
} from './types';

type RepositoryEntryKind = 'file' | 'directory';

function withSignal(init: RequestInit, signal?: AbortSignal): RequestInit {
	return signal ? { ...init, signal } : init;
}

function pathUrl(basePath: string, path: string): string {
	return `${basePath}?${new URLSearchParams({ path }).toString()}`;
}

export class RepositoryClient {
	readonly #basePath: string;

	constructor(sessionId: string) {
		this.#basePath = `/api/sessions/${encodeURIComponent(sessionId)}/repository`;
	}

	readSnapshot(signal?: AbortSignal): Promise<RepositorySnapshot> {
		return requestJson<RepositorySnapshot>(this.#basePath, signal ? { signal } : undefined, 'Unable to refresh this repository.');
	}

	readDirectory(path: string, signal?: AbortSignal): Promise<RepositoryDirectoryListing> {
		const endpoint = path ? pathUrl(`${this.#basePath}/directory`, path) : `${this.#basePath}/directory`;
		return requestJson<RepositoryDirectoryListing>(endpoint, signal ? { signal } : undefined, 'Unable to read this folder.');
	}

	readFile(path: string, signal?: AbortSignal): Promise<WorkspaceFile> {
		return requestJson<WorkspaceFile>(pathUrl(`${this.#basePath}/file`, path), signal ? { signal } : undefined, 'Unable to read this file.');
	}

	readDiff(path: string, signal?: AbortSignal): Promise<RepositoryDiff> {
		return requestJson<RepositoryDiff>(pathUrl(`${this.#basePath}/diff`, path), signal ? { signal } : undefined, 'Unable to read this diff.');
	}

	mediaUrl(path: string): string {
		return pathUrl(`${this.#basePath}/media`, path);
	}

	checkMedia(path: string, signal?: AbortSignal): Promise<Response> {
		return requestResponse(this.mediaUrl(path), withSignal({ method: 'HEAD' }, signal), 'This image cannot be previewed.');
	}

	createFile(path: string): Promise<WorkspaceFile> {
		return requestJson<WorkspaceFile>(`${this.#basePath}/file`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ path, content: '' })
		}, 'The file could not be created.');
	}

	updateFile(path: string, content: string, version: string): Promise<WorkspaceFile> {
		return requestJson<WorkspaceFile>(pathUrl(`${this.#basePath}/file`, path), {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ content, version })
		}, 'The file could not be saved.');
	}

	async createDirectory(path: string): Promise<void> {
		await requestJson<unknown>(`${this.#basePath}/directory`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ path })
		}, 'The folder could not be created.');
	}

	async deleteEntry(path: string, kind: RepositoryEntryKind): Promise<void> {
		const endpoint = kind === 'directory' ? 'directory' : 'file';
		const fallback = `The ${kind === 'directory' ? 'folder' : 'file'} could not be deleted.`;
		await requestJson<unknown>(pathUrl(`${this.#basePath}/${endpoint}`, path), { method: 'DELETE' }, fallback);
	}
}
