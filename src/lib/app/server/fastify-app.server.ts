import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyServerOptions } from 'fastify';
import { expectedRequestOrigin, requestHostAllowed } from '~/lib/server/runtime-config.ts';
import { authorizeSession, SECURE_SESSION_COOKIE_NAME, SESSION_COOKIE_NAME } from '~/lib/server/session-cookie.ts';
import { registerServerRoutes } from './fastify-routes.server.ts';
import { registerUploadRoutes } from './fastify-upload-routes.server.ts';
import { registerWorkspaceEventRoutes } from './fastify-workspace-events.server.ts';

const MAX_REQUEST_BODY_BYTES = 11 * 1024 * 1024;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export type CreateFastifyAppOptions = {
  clientDirectory?: string;
  injectedProtocolHeader?: string;
  logger?: FastifyServerOptions['logger'];
};

function applySecurityHeaders(reply: FastifyReply): void {
  reply.header('x-content-type-options', 'nosniff');
  reply.header('x-frame-options', 'DENY');
  reply.header('x-permitted-cross-domain-policies', 'none');
  reply.header('referrer-policy', 'no-referrer');
  reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  reply.header('cross-origin-opener-policy', 'same-origin');
  reply.header('cross-origin-resource-policy', 'same-origin');
  reply.header(
    'content-security-policy',
    "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'",
  );
}

export function createFastifyApp(options: CreateFastifyAppOptions = {}): FastifyInstance {
  const app = Fastify({
    bodyLimit: MAX_REQUEST_BODY_BYTES,
    logger: options.logger ?? false,
    routerOptions: { ignoreTrailingSlash: false },
  });

  app.register(fastifyCookie);

  app.addHook('onRequest', (request, reply, done) => {
    if (options.injectedProtocolHeader) request.raw.headers[options.injectedProtocolHeader] = 'http';
    if (!requestHostAllowed(request.headers)) {
      void reply.status(421).send('Misdirected Request');
      return;
    }

    if (!SAFE_METHODS.has(request.method)) {
      const origin = request.headers.origin;
      const expectedOrigin = expectedRequestOrigin(request.headers);
      if (origin && (!expectedOrigin || origin !== expectedOrigin)) {
        void reply.status(403).send('Forbidden');
        return;
      }
    }
    done();
  });

  app.addHook('onSend', (request, reply, payload, done) => {
    applySecurityHeaders(reply);
    const contentType = reply.getHeader('content-type');
    if (request.url.startsWith('/api/') || (typeof contentType === 'string' && contentType.startsWith('text/html'))) {
      reply.header('cache-control', 'no-store');
    }
    if (request.protocol === 'https') reply.header('strict-transport-security', 'max-age=31536000');
    done(null, payload);
  });

  app.get('/health', () => ({ status: 'ok' }));
  app.register(registerServerRoutes);
  app.register(registerWorkspaceEventRoutes);
  app.register(registerUploadRoutes);

  if (options.clientDirectory) {
    app.register(fastifyStatic, {
      root: options.clientDirectory,
      decorateReply: true,
      preCompressed: true,
    });
  }

  app.setNotFoundHandler(async (request, reply) => {
    if (request.url === '/api' || request.url.startsWith('/api/')) {
      const secureSession = authorizeSession(request.cookies[SECURE_SESSION_COOKIE_NAME]);
      const authorized = secureSession.authorized || authorizeSession(request.cookies[SESSION_COOKIE_NAME]).authorized;
      if (!authorized) {
        await reply.status(401).send({ message: 'Unauthorized' });
        return;
      }
    }
    if (
      options.clientDirectory &&
      request.method === 'GET' &&
      !request.url.startsWith('/api/') &&
      !request.url.startsWith('/events/')
    ) {
      await reply.type('text/html; charset=utf-8').sendFile('index.html');
      return;
    }
    await reply.status(404).send({ message: 'Not Found' });
  });

  return app;
}
