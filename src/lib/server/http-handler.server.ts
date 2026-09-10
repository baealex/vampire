export class HttpError extends Error {
  readonly body: { message: string };
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = { message };
  }
}

export function error(status: number, message: string): HttpError {
  return new HttpError(status, message);
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has('content-type')) headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(data), { ...init, headers });
}

export interface ServerCookieOptions {
  httpOnly?: boolean;
  maxAge?: number;
  path: string;
  sameSite?: boolean | 'lax' | 'strict' | 'none';
  secure?: boolean;
}

export interface ServerCookies {
  delete(name: string, options: ServerCookieOptions): void;
  get(name: string): string | undefined;
  set(name: string, value: string, options: ServerCookieOptions): void;
}

export interface ServerRequestEvent {
  cookies: ServerCookies;
  getClientAddress(): string;
  params: Record<string, string | undefined>;
  request: Request;
  url: URL;
}

export type RequestHandler = (event: ServerRequestEvent) => Response | Promise<Response>;
