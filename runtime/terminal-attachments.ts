export interface TerminalGeometry {
	columns: number;
	rows: number;
}

export interface ManagedTerminalAttachment {
	released: boolean;
	setIgnoreSize?: (ignored: boolean) => Promise<void>;
}

export interface TerminalAttachmentState<T extends ManagedTerminalAttachment> {
	attachments: Set<T>;
	activeAttachment?: T;
	activationQueue: Promise<void>;
	controlHistory: T[];
	geometry?: TerminalGeometry;
}

export function createTerminalAttachmentState<T extends ManagedTerminalAttachment>(): TerminalAttachmentState<T> {
	return {
		attachments: new Set(),
		activeAttachment: undefined,
		activationQueue: Promise.resolve(),
		controlHistory: [],
		geometry: undefined
	};
}

export function activateTerminalAttachment<T extends ManagedTerminalAttachment>(
	state: TerminalAttachmentState<T>,
	attachment: T,
	options: { onlyIfUnclaimed?: boolean } = {}
): Promise<boolean> {
	const activation = state.activationQueue
		.catch(() => undefined)
		.then(async () => {
			if (attachment.released || !attachment.setIgnoreSize) return false;
			const previous = state.activeAttachment;
			if (options.onlyIfUnclaimed && previous && previous !== attachment) return false;
			if (previous === attachment) {
				await attachment.setIgnoreSize(false);
				return false;
			}

			state.activeAttachment = attachment;
			try {
				// Make the new controller authoritative before removing the previous one.
				// This avoids a transient tmux state with no size-owning client.
				await attachment.setIgnoreSize(false);
				if (previous && !previous.released && previous.setIgnoreSize) await previous.setIgnoreSize(true);
				state.controlHistory = state.controlHistory.filter((candidate) => candidate !== attachment);
				state.controlHistory.push(attachment);
				return true;
			} catch (error) {
				const fallback = previous && !previous.released && previous.setIgnoreSize ? previous : undefined;
				state.activeAttachment = fallback;
				await Promise.allSettled([
					attachment.setIgnoreSize(true),
					fallback?.setIgnoreSize?.(false)
				]);
				throw error;
			}
		});
	state.activationQueue = activation.then(() => undefined, () => undefined);
	return activation;
}

export function releaseTerminalAttachment<T extends ManagedTerminalAttachment>(
	state: TerminalAttachmentState<T>,
	attachment: T
): T | undefined {
	if (attachment.released) return undefined;
	const wasActive = state.activeAttachment === attachment;
	attachment.released = true;
	state.attachments.delete(attachment);
	state.controlHistory = state.controlHistory.filter((candidate) => candidate !== attachment);
	if (!wasActive) return undefined;
	state.activeAttachment = undefined;
	// tmux falls back to a remaining client when its controller disconnects. Restore
	// only a device that previously held control so server and browser geometry agree.
	return state.controlHistory.findLast((candidate) => !candidate.released && Boolean(candidate.setIgnoreSize));
}

export function updateTerminalGeometry<T extends ManagedTerminalAttachment>(
	state: TerminalAttachmentState<T>,
	attachment: T,
	geometry: TerminalGeometry
): boolean {
	if (state.activeAttachment && state.activeAttachment !== attachment) return false;
	if (state.geometry?.columns === geometry.columns && state.geometry.rows === geometry.rows) return false;
	state.geometry = geometry;
	return true;
}

export function terminalAttachmentKey(sessionId: string, terminalId?: string): string {
	return `${sessionId}\u0000${terminalId ?? 'main'}`;
}
