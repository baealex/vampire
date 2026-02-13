import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { cancelWorker } from '../worker.js';

export async function projectRoutes(app: FastifyInstance) {
  const prisma = (app as any).prisma;

  // List projects
  app.get('/api/projects', async (_req, _reply) => {
    const projects = await prisma.project.findMany({
      include: { jobs: { orderBy: { createdAt: 'desc' }, take: 5 } },
      orderBy: { createdAt: 'desc' },
    });
    return { projects };
  });

  // Project detail
  app.get('/api/projects/:id', async (req, reply) => {
    const project = await prisma.project.findUnique({
      where: { id: Number((req.params as any).id) },
      include: { jobs: { orderBy: { createdAt: 'desc' } } },
    });
    if (!project) return reply.code(404).send({ error: 'Not found' });
    return { project };
  });

  // Create project
  app.post('/api/projects', async (req, reply) => {
    const { name, path, baseBranch, provider } = req.body as { name?: string; path?: string; baseBranch?: string; provider?: string };

    const errors: string[] = [];
    if (!name || !name.trim()) errors.push('Project name is required.');
    if (!path || !path.trim()) {
      errors.push('Project path is required.');
    } else if (!existsSync(path)) {
      errors.push(`Path does not exist: ${path}`);
    } else if (!statSync(path).isDirectory()) {
      errors.push(`Path is not a directory: ${path}`);
    } else if (!existsSync(join(path, '.git'))) {
      errors.push('Not a git repository.');
    }

    if (errors.length > 0) {
      return reply.code(400).send({ error: errors.join(' ') });
    }

    const project = await prisma.project.create({
      data: { name: name!.trim(), path: path!.trim(), baseBranch: baseBranch || 'main', provider: provider || 'claude' },
    });
    return reply.code(201).send({ project });
  });

  // Update project prompt
  app.patch('/api/projects/:id', async (req, _reply) => {
    const id = Number((req.params as any).id);
    const body = req.body as { prompt?: string; provider?: string };
    const data: Record<string, string> = {};
    if (body.prompt !== undefined) data.prompt = body.prompt;
    if (body.provider !== undefined) data.provider = body.provider;
    const project = await prisma.project.update({
      where: { id },
      data,
    });
    return { project };
  });

  // Browse directories (for path picker)
  app.get('/api/browse', async (req, reply) => {
    const dir = (req.query as any).path || process.env.HOME || '/';

    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      return reply.code(400).send({ error: 'Invalid directory path.' });
    }

    const { readdirSync } = await import('node:fs');
    const entries: { name: string; path: string; isGitRepo: boolean }[] = [];

    try {
      const items = readdirSync(dir, { withFileTypes: true });
      for (const item of items) {
        if (!item.isDirectory() || item.name.startsWith('.')) continue;
        const fullPath = join(dir, item.name);
        entries.push({
          name: item.name,
          path: fullPath,
          isGitRepo: existsSync(join(fullPath, '.git')),
        });
      }
    } catch (_) {
      return reply.code(403).send({ error: 'Cannot read directory.' });
    }

    entries.sort((a, b) => {
      if (a.isGitRepo !== b.isGitRepo) return a.isGitRepo ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return { dir, entries };
  });

  // Delete project
  app.delete('/api/projects/:id', async (req, reply) => {
    const id = Number((req.params as any).id);

    const runningJobs = await prisma.job.findMany({
      where: { projectId: id, status: 'running' },
    });
    for (const job of runningJobs) {
      cancelWorker(job.id);
    }

    await prisma.job.deleteMany({ where: { projectId: id } });
    await prisma.project.delete({ where: { id } });
    return reply.code(204).send();
  });
}
