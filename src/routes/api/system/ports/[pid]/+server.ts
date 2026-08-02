import { error, json, type RequestHandler } from '@sveltejs/kit';
import { requireAuthentication } from '$lib/server/auth';
import { ListeningPortError, terminateListeningProcess } from '$lib/server/listening-ports';

function terminationErrorStatus(reason: ListeningPortError['reason']): number {
	if (reason === 'invalid-request') return 400;
	if (reason === 'protected' || reason === 'permission-denied') return 403;
	if (reason === 'stale') return 409;
	if (reason === 'unsupported-platform') return 501;
	if (reason === 'tool-unavailable') return 503;
	return 500;
}

export const DELETE: RequestHandler = async (event) => {
	requireAuthentication(event);
	const pidParam = event.params.pid;
	if (!pidParam || !/^[1-9]\d*$/.test(pidParam)) throw error(400, 'Process ID is invalid.');
	const pid = Number(pidParam);
	if (!Number.isSafeInteger(pid)) throw error(400, 'Process ID is invalid.');

	const body: unknown = await event.request.json().catch(() => undefined);
	if (!body || typeof body !== 'object' || Array.isArray(body)) {
		throw error(400, 'Listening process details are required.');
	}
	const port = 'port' in body ? body.port : undefined;
	const processName = 'processName' in body ? body.processName : undefined;
	const cwd = 'cwd' in body ? body.cwd : undefined;
	if (!Number.isSafeInteger(port) || typeof port !== 'number' || port < 1 || port > 65_535) {
		throw error(400, 'Listening port is invalid.');
	}
	if (processName !== null && (typeof processName !== 'string' || processName.length > 1_024)) {
		throw error(400, 'Process name is invalid.');
	}
	if (cwd !== null && (typeof cwd !== 'string' || cwd.length > 32_768)) {
		throw error(400, 'Process working directory is invalid.');
	}

	try {
		await terminateListeningProcess({ pid, port, processName, cwd });
		return json({ ok: true });
	} catch (cause) {
		if (cause instanceof ListeningPortError) throw error(terminationErrorStatus(cause.reason), cause.message);
		throw error(500, 'Vampire could not stop this listening process.');
	}
};
