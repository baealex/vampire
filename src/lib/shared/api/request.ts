export class RequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type RequestPolicy = {
  timeoutMs?: number;
};

export async function readResponseError(response: Response, fallback = 'Request failed'): Promise<string> {
  const body: unknown = await response.json().catch(() => undefined);
  return body && typeof body === 'object' && 'message' in body && typeof body.message === 'string'
    ? body.message
    : fallback;
}

export async function requestResponse(
  path: string,
  init?: RequestInit,
  fallback = 'Request failed',
  policy: RequestPolicy = {}
): Promise<Response> {
  const timeoutMs = policy.timeoutMs;
  if (timeoutMs === undefined) return checkedResponse(await fetch(path, init), fallback);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Request timeout must be a positive number.');

  const controller = new AbortController();
  const upstreamSignal = init?.signal;
  let timedOut = false;
  const forwardAbort = () => controller.abort(upstreamSignal?.reason);
  if (upstreamSignal?.aborted) forwardAbort();
  else upstreamSignal?.addEventListener('abort', forwardAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return checkedResponse(await fetch(path, { ...init, signal: controller.signal }), fallback);
  } catch (error) {
    if (timedOut) throw new RequestError(408, `${fallback} timed out.`);
    throw error;
  } finally {
    clearTimeout(timer);
    upstreamSignal?.removeEventListener('abort', forwardAbort);
  }
}

async function checkedResponse(response: Response, fallback: string): Promise<Response> {
  if (!response.ok) {
    throw new RequestError(response.status, await readResponseError(response, fallback));
  }
  return response;
}

export async function requestJson<T>(
  path: string,
  init?: RequestInit,
  fallback = 'Request failed',
  policy: RequestPolicy = {}
): Promise<T> {
  const response = await requestResponse(path, init, fallback, policy);
  return response.json() as Promise<T>;
}

export function isUnauthorized(error: unknown): boolean {
  return error instanceof RequestError && error.status === 401;
}
