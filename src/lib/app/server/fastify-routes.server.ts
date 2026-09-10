import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ServerCookies, ServerRequestEvent } from '~/lib/server/http-handler.server.ts';
import { expectedRequestOrigin } from '~/lib/server/runtime-config.ts';
import { serverRouteManifest, type ServerRouteModule } from './fastify-route-manifest.server.ts';

const HTTP_METHODS = ['DELETE', 'GET', 'PATCH', 'POST', 'PUT'] as const;

type FastifyRouteParameters = Record<string, string | undefined>;

function requestHeaders(request: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, String(value));
    }
  }
  return headers;
}

function requestBody(request: FastifyRequest): BodyInit | undefined {
  if (request.method === 'GET' || request.method === 'HEAD' || request.body === undefined) return undefined;
  if (Buffer.isBuffer(request.body)) return new Uint8Array(request.body);
  if (typeof request.body === 'string') return request.body;
  return JSON.stringify(request.body);
}

function requestUrl(request: FastifyRequest): URL {
  const authority = request.headers.host ?? 'localhost';
  const origin = expectedRequestOrigin(request.headers) ?? `${request.protocol}://${authority}`;
  return new URL(request.raw.url ?? '/', origin);
}

function serverCookies(request: FastifyRequest, reply: FastifyReply): ServerCookies {
  return {
    delete(name, options) {
      reply.clearCookie(name, options);
    },
    get(name) {
      return request.cookies[name];
    },
    set(name, value, options) {
      reply.setCookie(name, value, options);
    },
  };
}

function serverRequestEvent(request: FastifyRequest, reply: FastifyReply): ServerRequestEvent {
  const url = requestUrl(request);
  const body = requestBody(request);
  const fetchRequest = new Request(url, {
    body,
    headers: requestHeaders(request),
    method: request.method,
    ...(body === undefined ? {} : { duplex: 'half' }),
  } as RequestInit & { duplex?: 'half' });

  return {
    cookies: serverCookies(request, reply),
    getClientAddress: () => request.ip,
    params: request.params as FastifyRouteParameters,
    request: fetchRequest,
    url,
  };
}

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || !('status' in error)) return undefined;
  return typeof error.status === 'number' ? error.status : undefined;
}

function errorMessage(error: object): string {
  if ('body' in error && error.body && typeof error.body === 'object' && 'message' in error.body) {
    const message = error.body.message;
    if (typeof message === 'string') return message;
  }
  if ('message' in error && typeof error.message === 'string') return error.message;
  return 'Request failed.';
}

async function sendResponse(response: Response, reply: FastifyReply): Promise<void> {
  reply.status(response.status);
  response.headers.forEach((value, name) => reply.header(name, value));
  if (!response.body) {
    await reply.send();
    return;
  }
  await reply.send(Buffer.from(await response.arrayBuffer()));
}

async function executeRoute(
  routeModule: ServerRouteModule,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const handler = routeModule[request.method as keyof ServerRouteModule];
  if (!handler) {
    await reply.status(405).send({ message: 'Method Not Allowed' });
    return;
  }

  try {
    await sendResponse(await handler(serverRequestEvent(request, reply)), reply);
  } catch (error) {
    const status = errorStatus(error);
    if (status !== undefined && error && typeof error === 'object') {
      await reply.status(status).send({ message: errorMessage(error) });
      return;
    }
    throw error;
  }
}

export async function registerServerRoutes(app: FastifyInstance): Promise<void> {
  for (const definition of serverRouteManifest) {
    const routeModule = await definition.load();
    for (const method of HTTP_METHODS) {
      if (!routeModule[method]) continue;
      app.route({
        method,
        url: definition.path,
        handler: (request, reply) => executeRoute(routeModule, request, reply),
      });
    }
  }
}
