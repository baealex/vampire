export class RequestError extends Error {
	constructor(
		readonly status: number,
		message: string
	) {
		super(message);
	}
}

export async function readResponseError(response: Response, fallback = 'Request failed'): Promise<string> {
	const body: unknown = await response.json().catch(() => undefined);
	return body && typeof body === 'object' && 'message' in body && typeof body.message === 'string'
		? body.message
		: fallback;
}

export async function requestResponse(path: string, init?: RequestInit, fallback = 'Request failed'): Promise<Response> {
	const response = await fetch(path, init);
	if (!response.ok) {
		throw new RequestError(response.status, await readResponseError(response, fallback));
	}
	return response;
}

export async function requestJson<T>(path: string, init?: RequestInit, fallback = 'Request failed'): Promise<T> {
	const response = await requestResponse(path, init, fallback);
	return response.json() as Promise<T>;
}

export function isUnauthorized(error: unknown): boolean {
	return error instanceof RequestError && error.status === 401;
}
