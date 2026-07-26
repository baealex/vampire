interface TouchScrollableTerminal {
	rows: number;
	element?: HTMLElement;
	clearSelection(): void;
	scrollLines(amount: number): void;
}

export function installTerminalTouchScroll(
	element: HTMLElement,
	getTerminal: () => TouchScrollableTerminal | undefined
): () => void {
	let pointerId: number | undefined;
	let lastY = 0;
	let rowHeight = 0;
	let remainder = 0;
	let scrolling = false;

	const isScrollbar = (target: EventTarget | null) =>
		target instanceof Element && Boolean(target.closest('.xterm-scrollable-element .scrollbar'));

	const reset = () => {
		pointerId = undefined;
		lastY = 0;
		rowHeight = 0;
		remainder = 0;
		scrolling = false;
	};

	const measureRowHeight = () => {
		const terminal = getTerminal();
		if (!terminal || terminal.rows <= 0) return 0;
		const screen = terminal.element?.querySelector<HTMLElement>('.xterm-screen');
		const height = screen?.getBoundingClientRect().height || element.clientHeight;
		return height / terminal.rows;
	};

	const handlePointerDown = (event: PointerEvent) => {
		if (event.pointerType !== 'touch' || !event.isPrimary || isScrollbar(event.target)) return;
		pointerId = event.pointerId;
		lastY = event.clientY;
		rowHeight = measureRowHeight();
		remainder = 0;
	};

	const handlePointerMove = (event: PointerEvent) => {
		const terminal = getTerminal();
		if (event.pointerType !== 'touch' || !event.isPrimary || event.pointerId !== pointerId || !terminal) return;
		if (rowHeight <= 0) rowHeight = measureRowHeight();
		if (rowHeight <= 0) return;
		remainder += lastY - event.clientY;
		lastY = event.clientY;
		const lines = Math.trunc(remainder / rowHeight);
		if (lines === 0) return;
		if (!scrolling) {
			scrolling = true;
			element.setPointerCapture(event.pointerId);
			terminal.clearSelection();
		}
		remainder -= lines * rowHeight;
		terminal.scrollLines(lines);
		event.preventDefault();
	};

	const handlePointerEnd = (event: PointerEvent) => {
		if (event.pointerId === pointerId) reset();
	};

	element.addEventListener('pointerdown', handlePointerDown);
	element.addEventListener('pointermove', handlePointerMove);
	element.addEventListener('pointerup', handlePointerEnd);
	element.addEventListener('pointercancel', handlePointerEnd);
	element.addEventListener('lostpointercapture', handlePointerEnd);

	return () => {
		element.removeEventListener('pointerdown', handlePointerDown);
		element.removeEventListener('pointermove', handlePointerMove);
		element.removeEventListener('pointerup', handlePointerEnd);
		element.removeEventListener('pointercancel', handlePointerEnd);
		element.removeEventListener('lostpointercapture', handlePointerEnd);
		reset();
	};
}
