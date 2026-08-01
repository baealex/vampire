import { error, json, type RequestHandler } from '@sveltejs/kit';
import { requireAuthentication } from '$lib/server/auth';
import {
	ImagePasteError,
	MAX_IMAGE_PASTE_BYTES,
	pasteImageToSession,
	SUPPORTED_IMAGE_TYPES
} from '$lib/server/image-paste';
import { findManagedSession } from '$lib/server/session-registry';

const MAX_UPLOAD_BODY_BYTES = MAX_IMAGE_PASTE_BYTES + 64 * 1024;

export const POST: RequestHandler = async (event) => {
	requireAuthentication(event);
	const id = event.params.id;
	if (!id) throw error(400, 'Session ID is required.');

	const declaredLength = Number(event.request.headers.get('content-length'));
	if (Number.isFinite(declaredLength) && declaredLength > MAX_UPLOAD_BODY_BYTES) {
		throw error(413, 'Image upload is too large.');
	}

	const session = await findManagedSession(id);
	if (!session) throw error(404, 'Session was not found.');
	if (session.state !== 'running') throw error(409, 'This tmux session is no longer running.');
	const requestedTerminalId = event.url.searchParams.get('terminal') ?? undefined;
	if (requestedTerminalId && !session.terminals.some((terminal) => terminal.id === requestedTerminalId)) {
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
		await pasteImageToSession({
			tmuxTarget: requestedTerminalId ?? session.tmuxSession,
			bytes: Buffer.from(await image.arrayBuffer()),
			mimeType
		});
		return json({ ok: true });
	} catch (cause) {
		if (cause instanceof ImagePasteError) {
			throw error(cause.reason === 'unsupported-platform' ? 501 : 503, cause.message);
		}
		throw error(500, 'Vampire could not paste the image into the terminal.');
	}
};
