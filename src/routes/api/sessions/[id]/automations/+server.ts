import { error, json, type RequestHandler } from '@sveltejs/kit';
import { requireAuthentication } from '$lib/server/auth';
import {
	createManagedSessionAutomation,
	listManagedSessionAutomations,
	SessionAutomationMutationError
} from '$lib/server/session-automations';

function automationError(cause: SessionAutomationMutationError): never {
	throw error(
		cause.reason === 'not-found' || cause.reason === 'automation-not-found'
			? 404
			: cause.reason === 'limit' ? 409 : 400,
		cause.message
	);
}

export const GET: RequestHandler = async (event) => {
	requireAuthentication(event);
	const id = event.params.id;
	if (!id) throw error(400, 'Session ID is required.');
	try {
		return json(
			{ automations: await listManagedSessionAutomations(id) },
			{ headers: { 'cache-control': 'no-store' } }
		);
	} catch (cause) {
		if (cause instanceof SessionAutomationMutationError) automationError(cause);
		throw error(500, 'Vampire could not load workspace automations.');
	}
};
export const POST: RequestHandler = async (event) => {
	requireAuthentication(event);
	const id = event.params.id;
	if (!id) throw error(400, 'Session ID is required.');
	const body: unknown = await event.request.json().catch(() => undefined);
	try {
		return json({ automation: await createManagedSessionAutomation(id, body) }, { status: 201 });
	} catch (cause) {
		if (cause instanceof SessionAutomationMutationError) automationError(cause);
		throw error(500, 'Vampire could not save the workspace automation.');
	}
};
