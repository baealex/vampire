import { Readable } from 'node:stream';
import fastifyMultipart from '@fastify/multipart';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { RepositoryReadError, uploadWorkspaceFile } from '~/lib/features/repository/server/repository.server.ts';
import {
  ImagePasteError,
  MAX_IMAGE_PASTE_BYTES,
  pasteImageToWorkspace,
  SUPPORTED_IMAGE_TYPES,
} from '~/lib/features/terminal/server/image-paste.server.ts';
import type { WorkspaceUploadConflict } from '~/lib/shared/contracts/repository.ts';
import { authorizeFastifySession } from './fastify-auth.server.ts';
import { findManagedWorkspace, findWorkspaceDirectory } from './workspace-registry.server.ts';

const MAX_RAW_UPLOAD_BYTES = 11 * 1024 * 1024;
const MAX_MULTIPART_BODY_BYTES = MAX_IMAGE_PASTE_BYTES + 64 * 1024;
const UPLOAD_CONFLICT_POLICIES = new Set<WorkspaceUploadConflict>(['reject', 'overwrite', 'rename']);

type WorkspaceParameters = { id: string };
type RawUploadQuery = { conflict?: string; path?: string };
type ImageUploadQuery = { terminal?: string };

function requireFastifyAuthentication(request: FastifyRequest, reply: FastifyReply): boolean {
  if (authorizeFastifySession(request).authorized) return true;
  void reply.status(401).send({ message: 'Unauthorized' });
  return false;
}

function repositoryErrorStatus(reason: string): number {
  if (reason === 'conflict') return 409;
  if (reason === 'invalid-path') return 400;
  if (reason === 'not-found') return 404;
  if (reason === 'too-large') return 413;
  if (reason === 'unsupported-file') return 415;
  return 503;
}

function boundedUploadStream(stream: Readable): ReadableStream<Uint8Array> {
  let received = 0;
  return (Readable.toWeb(stream) as ReadableStream<Uint8Array>).pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength;
        if (received > MAX_RAW_UPLOAD_BYTES) {
          controller.error(new RepositoryReadError('too-large', 'Uploads are limited to 11 MB.'));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

async function registerRawUploadRoute(app: FastifyInstance): Promise<void> {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', (_request, payload, done) => done(null, payload));
  app.post<{ Params: WorkspaceParameters; Querystring: RawUploadQuery }>(
    '/api/workspaces/:id/repository/upload',
    async (request, reply) => {
      if (!requireFastifyAuthentication(request, reply)) return;
      const workspace = await findWorkspaceDirectory(request.params.id);
      if (!workspace) return reply.status(404).send({ message: 'Workspace was not found.' });
      const path = request.query.path;
      if (!path) return reply.status(400).send({ message: 'File path is required.' });
      const conflict = request.query.conflict ?? 'reject';
      if (!UPLOAD_CONFLICT_POLICIES.has(conflict as WorkspaceUploadConflict)) {
        return reply.status(400).send({ message: 'Upload conflict policy is invalid.' });
      }
      const declaredLength = Number(request.headers['content-length']);
      if (Number.isFinite(declaredLength) && declaredLength > MAX_RAW_UPLOAD_BYTES) {
        return reply.status(413).send({ message: 'Uploads are limited to 11 MB.' });
      }
      try {
        const result = await uploadWorkspaceFile(workspace.cwd, path, boundedUploadStream(request.body as Readable), {
          conflict: conflict as WorkspaceUploadConflict,
        });
        return reply.status(201).send(result);
      } catch (error) {
        if (error instanceof RepositoryReadError) {
          return reply.status(repositoryErrorStatus(error.reason)).send({ message: error.message });
        }
        return reply.status(500).send({ message: 'Vampire could not add this file.' });
      }
    },
  );
}

async function registerImageUploadRoute(app: FastifyInstance): Promise<void> {
  await app.register(fastifyMultipart, {
    limits: { fileSize: MAX_IMAGE_PASTE_BYTES, files: 1, fields: 0, parts: 1 },
  });
  app.post<{ Params: WorkspaceParameters; Querystring: ImageUploadQuery }>(
    '/api/workspaces/:id/image',
    { bodyLimit: MAX_MULTIPART_BODY_BYTES },
    async (request, reply) => {
      if (!requireFastifyAuthentication(request, reply)) return;
      const declaredLength = Number(request.headers['content-length']);
      if (Number.isFinite(declaredLength) && declaredLength > MAX_MULTIPART_BODY_BYTES) {
        return reply.status(413).send({ message: 'Image upload is too large.' });
      }
      const workspace = await findManagedWorkspace(request.params.id);
      if (!workspace) return reply.status(404).send({ message: 'Workspace was not found.' });
      if (workspace.state !== 'running') {
        return reply.status(409).send({ message: 'This tmux session is no longer running.' });
      }
      const terminalId = request.query.terminal;
      if (terminalId && !workspace.terminals.some((terminal) => terminal.id === terminalId)) {
        return reply.status(400).send({ message: 'Terminal does not belong to this workspace.' });
      }
      try {
        const image = await request.file();
        if (!image || image.fieldname !== 'image') {
          return reply.status(400).send({ message: 'An image file is required.' });
        }
        const mimeType = image.mimetype.toLowerCase();
        if (!SUPPORTED_IMAGE_TYPES.has(mimeType)) {
          image.file.resume();
          return reply.status(415).send({ message: 'Use a PNG, JPEG, GIF, WebP, or AVIF image.' });
        }
        const bytes = await image.toBuffer();
        if (image.file.truncated || bytes.byteLength > MAX_IMAGE_PASTE_BYTES) {
          return reply.status(413).send({ message: 'Image uploads are limited to 10 MB.' });
        }
        if (bytes.byteLength === 0) return reply.status(400).send({ message: 'The image is empty.' });
        await pasteImageToWorkspace({ tmuxTarget: terminalId ?? workspace.tmuxSession, bytes, mimeType });
        return reply.send({ ok: true });
      } catch (error) {
        if (error instanceof ImagePasteError) {
          return reply.status(error.reason === 'unsupported-platform' ? 501 : 503).send({ message: error.message });
        }
        if (error && typeof error === 'object' && 'code' in error && error.code === 'FST_REQ_FILE_TOO_LARGE') {
          return reply.status(413).send({ message: 'Image uploads are limited to 10 MB.' });
        }
        return reply.status(400).send({ message: 'Image upload is invalid.' });
      }
    },
  );
}

export async function registerUploadRoutes(app: FastifyInstance): Promise<void> {
  await app.register(registerRawUploadRoute);
  await app.register(registerImageUploadRoute);
}
