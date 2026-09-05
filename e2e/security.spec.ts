import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { expect, test } from '@playwright/test';
import { E2E_BASE_URL, E2E_TOKEN } from './runtime.ts';

const workspaceId = '00000000-0000-4000-8000-000000000000';

async function protectedApiRequests(): Promise<Array<{ path: string; method: string }>> {
  const root = join(import.meta.dirname, '../src/routes');
  const entries = await readdir(join(root, 'api'), { recursive: true });
  const requests: Array<{ path: string; method: string }> = [];
  for (const entry of entries.filter((entry) => entry.endsWith('+server.ts'))) {
    const file = join(root, 'api', entry);
    const path = `/${relative(root, file).replaceAll('\\', '/').replace('/+server.ts', '')}`;
    if (path === '/api/login' || path === '/api/status') continue;
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(/export const (GET|HEAD|POST|PUT|PATCH|DELETE):/g)) {
      requests.push({ path: path.replace(/\[[^\]]+\]/g, workspaceId), method: match[1]! });
    }
  }
  return requests;
}

test('security: every protected HTTP handler rejects requests without a session', async ({ request }) => {
  const endpoints = await protectedApiRequests();
  expect(endpoints.length).toBeGreaterThan(40);
  for (const { path, method } of endpoints) {
    const response = await request.fetch(path, { method });
    expect(response.status(), `${method} ${path}`).toBe(401);
  }
  for (const path of ['/api/%77orkspaces', '/api/workspaces/', '/api/workspaces?token=' + E2E_TOKEN]) {
    const response = await request.get(path, { headers: { authorization: `Bearer ${E2E_TOKEN}` } });
    expect(response.status(), path).toBe(401);
  }
  const status = await request.get('/api/status');
  expect(await status.json()).toEqual({ authenticationRequired: true, authenticated: false, tmux: null });
});

test('security: hostile hosts, origins, and unauthenticated websocket upgrades are rejected', async ({ request }) => {
  const wrongHost = await request.get('/api/status', { headers: { host: 'attacker.example' } });
  expect(wrongHost.status()).toBe(421);
  const spoofedForwarding = await request.post('/api/login', {
    headers: {
      origin: 'https://attacker.example',
      'x-forwarded-host': 'attacker.example',
      'x-forwarded-proto': 'https',
    },
    data: { token: E2E_TOKEN },
  });
  expect(spoofedForwarding.status()).toBe(403);
  for (const path of ['/ws/workspace', `/ws/terminal?workspace=${workspaceId}`]) {
    for (const origin of [undefined, 'null', 'https://attacker.example', E2E_BASE_URL]) {
      const response = await request.get(path, {
        headers: {
          connection: 'Upgrade',
          upgrade: 'websocket',
          'sec-websocket-version': '13',
          'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
          ...(origin ? { origin } : {}),
        },
      });
      expect(response.status(), `${path} origin=${origin}`).toBe(origin === E2E_BASE_URL ? 401 : 403);
    }
  }
});

test('security: authenticated writes reject foreign origins and logout revokes the session', async ({ request }) => {
  const login = await request.post('/api/login', { data: { token: E2E_TOKEN } });
  expect(login.ok()).toBe(true);
  const cookie = login.headers()['set-cookie'];
  expect(cookie).toContain('HttpOnly');
  expect(cookie).toContain('SameSite=Strict');
  const session = (await request.storageState()).cookies.find((cookie) => cookie.name === 'vampire_session');
  expect(session).toBeDefined();
  const cookieHeader = `vampire_session=${session!.value}`;
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    for (const origin of ['null', 'https://attacker.example']) {
      const response = await request.fetch('/api/terminal-input/settings', {
        method,
        headers: { origin },
        data: {},
      });
      expect(response.status(), `${method} origin=${origin}`).toBe(403);
    }
  }
  expect((await request.get('/api/terminal-input/settings')).ok()).toBe(true);
  expect((await request.delete('/api/login')).ok()).toBe(true);
  expect((await request.get('/api/terminal-input/settings', { headers: { cookie: cookieHeader } })).status()).toBe(401);
});
