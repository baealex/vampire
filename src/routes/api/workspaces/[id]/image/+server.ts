import { error, json, type RequestHandler } from '@sveltejs/kit';
import { requireAuthentication } from '~/lib/features/auth/server/auth';
import {
  ImagePasteError,
  MAX_IMAGE_PASTE_BYTES,
  pasteImageToWorkspace,
  SUPPORTED_IMAGE_TYPES,
} from '~/lib/features/terminal/server/image-paste';
import { findManagedWorkspace } from '~/lib/app/server/workspace-registry';

const MAX_UPLOAD_BODY_BYTES = MAX_IMAGE_PASTE_BYTES + 64 * 1024;

export const POST: RequestHandler = async (event) => {
  requireAuthentication(event);
  const id = event.params.id;
  if (!id) throw error(400, 'Workspace ID is required.');

  const declaredLength = Number(event.request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_UPLOAD_BODY_BYTES) {
    throw error(413, 'Image upload is too large.');
  }

  const workspace = await findManagedWorkspace(id);
  if (!workspace) throw error(404, 'Workspace was not found.');
  if (workspace.state !== 'running') throw error(409, 'This tmux session is no longer running.');
  const requestedTerminalId = event.url.searchParams.get('terminal') ?? undefined;
  if (requestedTerminalId && !workspace.terminals.some((terminal) => terminal.id === requestedTerminalId)) {
    throw error(400, 'Terminal does not belong to this workspace.');
  }

  let form: FormData;
  try {
    form = await event.request.formData();
  } catch {
    throw error(400, 'Image upload is invalid.');
  }

  const value = form.get('image');
  if (!value || typeof value !== 'object' || typeof (value as File).arrayBuffer !== 'function') {
    throw error(400, 'An image file is required.');
  }

  const image = value as File;
  const mimeType = image.type.toLowerCase();
  if (!SUPPORTED_IMAGE_TYPES.has(mimeType)) {
    throw error(415, 'Use a PNG, JPEG, GIF, WebP, or AVIF image.');
  }
  if (image.size <= 0) throw error(400, 'The image is empty.');
  if (image.size > MAX_IMAGE_PASTE_BYTES) throw error(413, 'Image uploads are limited to 10 MB.');

  try {
    await pasteImageToWorkspace({
      tmuxTarget: requestedTerminalId ?? workspace.tmuxSession,
      bytes: Buffer.from(await image.arrayBuffer()),
      mimeType,
    });
    return json({ ok: true });
  } catch (cause) {
    if (cause instanceof ImagePasteError) {
      throw error(cause.reason === 'unsupported-platform' ? 501 : 503, cause.message);
    }
    throw error(500, 'Vampire could not paste the image into the terminal.');
  }
};
