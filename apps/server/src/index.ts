import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { PrismaClient } from '@prisma/client';
import { projectRoutes } from './routes/projects.js';
import { jobRoutes } from './routes/jobs.js';
import { providerRoutes } from './routes/providers.js';

export interface CreateAppOptions {
  staticDir?: string;
}

export async function createApp(options: CreateAppOptions = {}) {
  const prisma = new PrismaClient();
  const app = Fastify({ logger: true });

  app.decorate('prisma', prisma);

  app.register(projectRoutes);
  app.register(jobRoutes);
  app.register(providerRoutes);

  // SPA 정적 파일 서빙
  const distDir = options.staticDir;
  if (distDir && existsSync(distDir)) {
    app.register(fastifyStatic, {
      root: distDir,
      prefix: '/',
      wildcard: false,
    });

    // SPA fallback — /api 외 모든 GET을 index.html로
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) {
        return reply.sendFile('index.html');
      }
      reply.code(404).send({ error: 'Not found' });
    });
  }

  return { app, prisma };
}
