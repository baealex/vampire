import type { FastifyInstance } from 'fastify';
import { runWorker, cancelWorker, logEmitter } from '../worker.js';
import { createIssue, createPR } from '../services/github.js';

export async function jobRoutes(app: FastifyInstance) {
  const prisma = (app as any).prisma;

  // Job detail
  app.get('/api/jobs/:jobId', async (req, reply) => {
    const job = await prisma.job.findUnique({
      where: { id: Number((req.params as any).jobId) },
      include: { project: true },
    });
    if (!job) return reply.code(404).send({ error: 'Not found' });
    return { job };
  });

  // Create job
  app.post('/api/projects/:id/jobs', async (req, reply) => {
    const project = await prisma.project.findUnique({
      where: { id: Number((req.params as any).id) },
    });
    if (!project) return reply.code(404).send({ error: 'Not found' });

    const { type, mode } = req.body as { type?: string; mode?: string; issueTitle?: string; issueBody?: string; issueNo?: number };
    let issueNum: number | null = null;
    let jobTitle = '';
    let jobDescription = '';

    if (mode === 'direct') {
      const { issueTitle, issueBody } = req.body as { issueTitle?: string; issueBody?: string };
      if (!issueTitle || !issueTitle.trim()) {
        return reply.code(400).send({ error: 'Title is required.' });
      }
      jobTitle = issueTitle.trim();
      jobDescription = issueBody?.trim() || '';
    } else if (mode === 'create') {
      const { issueTitle, issueBody } = req.body as { issueTitle?: string; issueBody?: string };
      if (!issueTitle || !issueTitle.trim()) {
        return reply.code(400).send({ error: 'Issue title is required.' });
      }
      try {
        issueNum = await createIssue(project.path, { title: issueTitle, body: issueBody });
      } catch (e: any) {
        return reply.code(500).send({ error: 'Failed to create issue: ' + e.message });
      }
      jobTitle = issueTitle;
    } else {
      issueNum = Number((req.body as any).issueNo);
      if (!issueNum || issueNum <= 0 || !Number.isInteger(issueNum)) {
        return reply.code(400).send({ error: 'Please enter a valid issue number.' });
      }
    }

    if (issueNum != null) {
      const existingRunning = await prisma.job.findFirst({
        where: { projectId: project.id, issueNo: issueNum, status: 'running' },
      });
      if (existingRunning) {
        return { job: existingRunning };
      }
    }

    const job = await prisma.job.create({
      data: {
        projectId: project.id,
        issueNo: issueNum,
        issueTitle: jobTitle,
        description: jobDescription,
        type: type || 'feat',
        status: 'running',
      },
    });

    runWorker({ job, project, prisma });

    return reply.code(201).send({ job });
  });

  // Cancel job
  app.post('/api/jobs/:jobId/cancel', async (req, reply) => {
    const job = await prisma.job.findUnique({
      where: { id: Number((req.params as any).jobId) },
      include: { project: true },
    });
    if (!job) return reply.code(404).send({ error: 'Not found' });
    if (job.status !== 'running') {
      return { job };
    }

    cancelWorker(job.id);

    const updated = await prisma.job.update({
      where: { id: job.id },
      data: { status: 'cancelled' },
      include: { project: true },
    });

    return { job: updated };
  });

  // Retry job
  app.post('/api/jobs/:jobId/retry', async (req, reply) => {
    const oldJob = await prisma.job.findUnique({
      where: { id: Number((req.params as any).jobId) },
      include: { project: true },
    });
    if (!oldJob) return reply.code(404).send({ error: 'Not found' });
    if (oldJob.status === 'running') {
      return { job: oldJob };
    }

    const newJob = await prisma.job.create({
      data: {
        projectId: oldJob.projectId,
        issueNo: oldJob.issueNo,
        issueTitle: oldJob.issueTitle,
        description: oldJob.description,
        type: oldJob.type,
        status: 'running',
      },
    });

    runWorker({ job: newJob, project: oldJob.project, prisma });

    return reply.code(201).send({ job: newJob });
  });

  // Delete job
  app.delete('/api/jobs/:jobId', async (req, reply) => {
    const job = await prisma.job.findUnique({
      where: { id: Number((req.params as any).jobId) },
    });
    if (!job) return reply.code(404).send({ error: 'Not found' });

    if (job.status === 'running') {
      cancelWorker(job.id);
    }

    await prisma.job.delete({ where: { id: job.id } });

    return reply.code(204).send();
  });

  // Follow-up: continue work with additional feedback
  app.post('/api/jobs/:jobId/followup', async (req, reply) => {
    const oldJob = await prisma.job.findUnique({
      where: { id: Number((req.params as any).jobId) },
      include: { project: true },
    });
    if (!oldJob) return reply.code(404).send({ error: 'Not found' });
    if (!oldJob.branch) {
      return reply.code(400).send({ error: 'Previous job has no branch.' });
    }

    const { message } = req.body as { message?: string };
    if (!message || !message.trim()) {
      return reply.code(400).send({ error: 'Feedback message is required.' });
    }

    const newJob = await prisma.job.create({
      data: {
        projectId: oldJob.projectId,
        issueNo: oldJob.issueNo,
        issueTitle: oldJob.issueTitle,
        description: oldJob.description,
        type: oldJob.type,
        status: 'running',
      },
    });

    runWorker({
      job: newJob,
      project: oldJob.project,
      prisma,
      followUp: {
        branch: oldJob.branch,
        message: message.trim(),
        previousDiff: oldJob.diff,
      },
    });

    return reply.code(201).send({ job: newJob });
  });

  // Create PR
  app.post('/api/jobs/:jobId/pr', async (req, reply) => {
    const job = await prisma.job.findUnique({
      where: { id: Number((req.params as any).jobId) },
      include: { project: true },
    });
    if (!job) return reply.code(404).send({ error: 'Not found' });
    if (job.prUrl) {
      return { job };
    }

    const { prTitle, prBody } = req.body as { prTitle: string; prBody: string };

    try {
      const prUrl = await createPR(job.project.path, {
        title: prTitle,
        body: prBody,
        base: job.project.baseBranch,
        head: job.branch!,
      });

      const updated = await prisma.job.update({
        where: { id: job.id },
        data: { prUrl, prBody, prTitle },
        include: { project: true },
      });

      return { job: updated };
    } catch (e: any) {
      const errorMsg = e.stderr || e.message;
      return reply.code(500).send({ error: errorMsg });
    }
  });

  // SSE log streaming
  app.get('/api/jobs/:jobId/log', async (req, reply) => {
    const job = await prisma.job.findUnique({
      where: { id: Number((req.params as any).jobId) },
    });
    if (!job) return reply.code(404).send('Not found');

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    if (job.status !== 'running') {
      reply.raw.write(`event: done\ndata: ${job.status}\n\n`);
      reply.raw.end();
      return;
    }

    const onLog = (chunk: string) => {
      reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
    };
    const onDone = (status: string) => {
      reply.raw.write(`event: done\ndata: ${status || 'done'}\n\n`);
      reply.raw.end();
    };

    logEmitter.on(`job:${job.id}`, onLog);
    logEmitter.once(`job:${job.id}:done`, onDone);

    req.raw.on('close', () => {
      logEmitter.off(`job:${job.id}`, onLog);
      logEmitter.off(`job:${job.id}:done`, onDone);
    });
  });
}
