export class RequestError extends Error {
	constructor(
		readonly status: number,
		message: string
	) {
		super(message);
	}
}

export async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(path, init);
	if (!response.ok) {
		const body: unknown = await response.json().catch(() => undefined);
		const message = body && typeof body === 'object' && 'message' in body && typeof body.message === 'string'
			? body.message
			: 'Request failed';
		throw new RequestError(response.status, message);
	}
	return response.json() as Promise<T>;
}

export function isUnauthorized(error: unknown): boolean {
	return error instanceof RequestError && error.status === 401;
}
