import { error, json, type RequestHandler } from '@sveltejs/kit';
import { requireAuthentication } from '$lib/server/auth';
import {
	deleteManagedSessionAutomation,
	SessionAutomationMutationError,
	setManagedSessionAutomationEnabled
} from '$lib/server/session-automations';

function automationError(cause: SessionAutomationMutationError): never {
	throw error(
		cause.reason === 'not-found' || cause.reason === 'automation-not-found'
			? 404
			: cause.reason === 'limit' ? 409 : 400,
		cause.message
	);
}

function routeIds(event: Parameters<RequestHandler>[0]): { sessionId: string; automationId: string } {
	const sessionId = event.params.id;
	const automationId = event.params.automationId;
	if (!sessionId) throw error(400, 'Session ID is required.');
	if (!automationId) throw error(400, 'Automation ID is required.');
	return { sessionId, automationId };
}

export const PATCH: RequestHandler = async (event) => {
	requireAuthentication(event);
	const { sessionId, automationId } = routeIds(event);
	const body: unknown = await event.request.json().catch(() => undefined);
	const enabled = body && typeof body === 'object' && !Array.isArray(body) && 'enabled' in body
		? body.enabled
		: undefined;
	if (typeof enabled !== 'boolean') throw error(400, 'Enabled must be a boolean.');
	try {
		return json({
			automation: await setManagedSessionAutomationEnabled(sessionId, automationId, enabled)
		});
	} catch (cause) {
		if (cause instanceof SessionAutomationMutationError) automationError(cause);
		throw error(500, 'Vampire could not update the workspace automation.');
	}
};
export const DELETE: RequestHandler = async (event) => {
	requireAuthentication(event);
	const { sessionId, automationId } = routeIds(event);
	try {
		await deleteManagedSessionAutomation(sessionId, automationId);
		return json({ ok: true });
	} catch (cause) {
		if (cause instanceof SessionAutomationMutationError) automationError(cause);
		throw error(500, 'Vampire could not delete the workspace automation.');
	}
};
