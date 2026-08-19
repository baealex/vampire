import assert from 'node:assert/strict';
import test from 'node:test';
import {
	activateTerminalAttachment,
	createTerminalAttachmentState,
	releaseTerminalAttachment,
	terminalAttachmentKey,
	updateTerminalGeometry,
	type ManagedTerminalAttachment
} from '../runtime/terminal-attachments.ts';

function attachment(name: string, events: string[]): ManagedTerminalAttachment & { name: string } {
	return {
		name,
		released: false,
		setIgnoreSize: async (ignored) => { events.push(`${name}:${ignored ? 'viewer' : 'control'}`); }
	};
}

test('hands terminal control over only when explicitly activated', async () => {
	const events: string[] = [];
	const state = createTerminalAttachmentState<ReturnType<typeof attachment>>();
	const desktop = attachment('desktop', events);
	const phone = attachment('phone', events);
	state.attachments.add(desktop);
	state.attachments.add(phone);

	assert.equal(state.activeAttachment, undefined);
	assert.equal(await activateTerminalAttachment(state, desktop), true);
	assert.equal(await activateTerminalAttachment(state, phone), true);
	assert.equal(await activateTerminalAttachment(state, phone), false);

	assert.equal(state.activeAttachment, phone);
	assert.deepEqual(events, ['desktop:control', 'phone:control', 'desktop:viewer', 'phone:control']);
});

test('does not let a passive attachment take an existing controller', async () => {
	const events: string[] = [];
	const state = createTerminalAttachmentState<ReturnType<typeof attachment>>();
	const desktop = attachment('desktop', events);
	const reconnectingPhone = attachment('phone', events);
	state.attachments.add(desktop);
	state.attachments.add(reconnectingPhone);
	await activateTerminalAttachment(state, desktop, { onlyIfUnclaimed: true });
	await activateTerminalAttachment(state, reconnectingPhone, { onlyIfUnclaimed: true });

	assert.equal(state.activeAttachment, desktop);
	assert.deepEqual(events, ['desktop:control']);

	await activateTerminalAttachment(state, reconnectingPhone);
	assert.equal(state.activeAttachment, reconnectingPhone);
});

test('promotes a remaining viewer when the controller disconnects', async () => {
	const events: string[] = [];
	const state = createTerminalAttachmentState<ReturnType<typeof attachment>>();
	const desktop = attachment('desktop', events);
	const phone = attachment('phone', events);
	state.attachments.add(desktop);
	state.attachments.add(phone);
	await activateTerminalAttachment(state, desktop);

	const fallback = releaseTerminalAttachment(state, desktop);
	assert.equal(fallback, phone);
	if (fallback) await activateTerminalAttachment(state, fallback);

	assert.equal(state.activeAttachment, phone);
	assert.equal(state.attachments.has(phone), true);
	assert.deepEqual(events, ['desktop:control', 'phone:control']);
});

test('restores the most recent previous controller when the current one disconnects', async () => {
	const events: string[] = [];
	const state = createTerminalAttachmentState<ReturnType<typeof attachment>>();
	const desktop = attachment('desktop', events);
	const phone = attachment('phone', events);
	state.attachments.add(desktop);
	state.attachments.add(phone);
	await activateTerminalAttachment(state, desktop);
	await activateTerminalAttachment(state, phone);

	const fallback = releaseTerminalAttachment(state, phone);
	assert.equal(fallback, desktop);
	if (fallback) await activateTerminalAttachment(state, fallback);

	assert.equal(state.activeAttachment, desktop);
	assert.deepEqual(events, [
		'desktop:control',
		'phone:control',
		'desktop:viewer',
		'desktop:control'
	]);
});

test('synchronizes every screen only after the previous controller relinquishes size', async () => {
	const events: string[] = [];
	const state = createTerminalAttachmentState<ManagedTerminalAttachment>();
	const managed = (name: string, geometry: { columns: number; rows: number }): ManagedTerminalAttachment => ({
		released: false,
		setIgnoreSize: async (ignored) => {
			events.push(`${name}:${ignored ? 'viewer' : 'control'}`);
			if (!ignored) state.geometry = geometry;
		},
		synchronizeScreen: async (shared) => {
			events.push(`${name}:sync:${shared?.columns}x${shared?.rows}`);
		}
	});
	const desktop = managed('desktop', { columns: 120, rows: 40 });
	const phone = managed('phone', { columns: 48, rows: 20 });
	state.attachments.add(desktop);
	state.attachments.add(phone);
	await activateTerminalAttachment(state, desktop);
	events.length = 0;

	await activateTerminalAttachment(state, phone);

	assert.deepEqual(events, [
		'phone:control',
		'desktop:viewer',
		'desktop:sync:48x20',
		'phone:sync:48x20'
	]);
});

test('keeps the new controller when the former controller cannot be demoted', async () => {
	const events: string[] = [];
	const state = createTerminalAttachmentState<ManagedTerminalAttachment>();
	const desktop: ManagedTerminalAttachment = {
		released: false,
		setIgnoreSize: async (ignored) => {
			events.push(`desktop:${ignored ? 'viewer' : 'control'}`);
			if (ignored) throw new Error('desktop control client disappeared');
		},
		synchronizeScreen: async () => { events.push('desktop:sync'); },
		terminate: () => events.push('desktop:terminated')
	};
	const phone: ManagedTerminalAttachment = {
		released: false,
		setIgnoreSize: async (ignored) => { events.push(`phone:${ignored ? 'viewer' : 'control'}`); },
		synchronizeScreen: async () => { events.push('phone:sync'); }
	};
	state.attachments.add(desktop);
	state.attachments.add(phone);
	await activateTerminalAttachment(state, desktop);
	events.length = 0;

	assert.equal(await activateTerminalAttachment(state, phone), true);
	assert.equal(state.activeAttachment, phone);
	assert.deepEqual(events, [
		'phone:control',
		'desktop:viewer',
		'desktop:terminated',
		'phone:sync'
	]);
});

test('keeps the former controller when the new controller cannot be promoted', async () => {
	const events: string[] = [];
	const state = createTerminalAttachmentState<ManagedTerminalAttachment>();
	const desktop: ManagedTerminalAttachment = {
		released: false,
		setIgnoreSize: async (ignored) => {
			events.push(`desktop:${ignored ? 'viewer' : 'control'}`);
		}
	};
	const phone: ManagedTerminalAttachment = {
		released: false,
		setIgnoreSize: async (ignored) => {
			events.push(`phone:${ignored ? 'viewer' : 'control'}`);
			if (!ignored) throw new Error('phone control client unavailable');
		}
	};
	state.attachments.add(desktop);
	state.attachments.add(phone);
	await activateTerminalAttachment(state, desktop);

	await assert.rejects(() => activateTerminalAttachment(state, phone));
	assert.equal(state.activeAttachment, desktop);
	assert.deepEqual(events, [
		'desktop:control',
		'phone:control',
		'phone:viewer',
		'desktop:control'
	]);
});

test('does not roll back layout ownership when a screen redraw fails', async () => {
	const state = createTerminalAttachmentState<ManagedTerminalAttachment>();
	const controller: ManagedTerminalAttachment = {
		released: false,
		setIgnoreSize: async () => undefined,
		synchronizeScreen: async () => { throw new Error('browser redraw failed'); }
	};
	state.attachments.add(controller);

	assert.equal(await activateTerminalAttachment(state, controller), true);
	assert.equal(state.activeAttachment, controller);
});

test('accepts geometry only from the controller once one exists', async () => {
	const events: string[] = [];
	const state = createTerminalAttachmentState<ReturnType<typeof attachment>>();
	const desktop = attachment('desktop', events);
	const phone = attachment('phone', events);
	state.attachments.add(desktop);
	state.attachments.add(phone);

	assert.equal(updateTerminalGeometry(state, phone, { columns: 48, rows: 20 }), true);
	await activateTerminalAttachment(state, desktop);
	assert.equal(updateTerminalGeometry(state, phone, { columns: 50, rows: 22 }), false);
	assert.equal(updateTerminalGeometry(state, desktop, { columns: 120, rows: 40 }), true);
	assert.deepEqual(state.geometry, { columns: 120, rows: 40 });
});

test('isolates attachment ownership by terminal', () => {
	assert.notEqual(terminalAttachmentKey('session', '@1'), terminalAttachmentKey('session', '@2'));
	assert.notEqual(terminalAttachmentKey('session'), terminalAttachmentKey('session', '@1'));
});
