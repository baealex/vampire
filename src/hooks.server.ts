import type { Handle } from '@sveltejs/kit';
import { requireAuthentication } from '~/lib/features/auth/server/auth.server.ts';

const PUBLIC_API_PATHS = new Set(['/api/login', '/api/status']);

export const handle: Handle = async ({ event, resolve }) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(event.request.method)) {
    const origin = event.request.headers.get('origin');
    if (origin && origin !== event.url.origin) {
      return new Response('Forbidden', { status: 403 });
    }
  }
  if (event.url.pathname.startsWith('/api/') && !PUBLIC_API_PATHS.has(event.url.pathname)) {
    requireAuthentication(event);
  }

  const response = await resolve(event);
  response.headers.set('x-content-type-options', 'nosniff');
  response.headers.set('x-frame-options', 'DENY');
  response.headers.set('x-permitted-cross-domain-policies', 'none');
  response.headers.set('referrer-policy', 'no-referrer');
  response.headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  response.headers.set('cross-origin-opener-policy', 'same-origin');
  response.headers.set('cross-origin-resource-policy', 'same-origin');
  if (event.url.protocol === 'https:') {
    response.headers.set('strict-transport-security', 'max-age=31536000');
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (event.url.pathname.startsWith('/api/') || contentType.startsWith('text/html')) {
    response.headers.set('cache-control', 'no-store');
  }
  return response;
};
