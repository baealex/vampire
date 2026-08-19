import assert from 'node:assert/strict';
import test from 'node:test';
import * as touchScroll from '../src/lib/terminal/touch-scroll.ts';

class StubElement {}
const originalElement = globalThis.Element;
Object.defineProperty(globalThis, 'Element', { configurable: true, value: StubElement });

test.after(() => {
	if (originalElement === undefined) Reflect.deleteProperty(globalThis, 'Element');
	else Object.defineProperty(globalThis, 'Element', { configurable: true, value: originalElement });
});

type Listener = (event: any) => void;

function fixture() {
	const listeners = new Map<string, Listener[]>();
	const scrollLines: number[] = [];
	const scrollAttempts: number[] = [];
	let selectionCleared = 0;
	let scrollStarted = 0;
	let tapped = 0;
	let capturedPointer: number | undefined;
	const element = {
		clientHeight: 100,
		addEventListener(name: string, listener: Listener) {
			const registered = listeners.get(name) ?? [];
			registered.push(listener);
			listeners.set(name, registered);
		},
		removeEventListener() {},
		setPointerCapture(pointerId: number) { capturedPointer = pointerId; }
	};
	const terminal = {
		rows: 10,
		element: { querySelector: () => ({ getBoundingClientRect: () => ({ height: 100 }) }) },
		clearSelection() { selectionCleared += 1; },
		scrollLines(lines: number) { scrollLines.push(lines); }
	};
	touchScroll.installTerminalTouchScroll(element as unknown as HTMLElement, () => terminal as unknown as {
		rows: number;
		element: HTMLElement;
		clearSelection(): void;
		scrollLines(lines: number): void;
	}, {
		onScrollAttempt: (lines) => scrollAttempts.push(lines),
		onScrollStart: () => { scrollStarted += 1; },
		onTap: () => { tapped += 1; }
	});
	const fire = (name: string, event: any): void => {
		for (const listener of listeners.get(name) ?? []) listener(event);
	};
	return {
		fire,
		scrollAttempts,
		scrollLines,
		get capturedPointer() { return capturedPointer; },
		get tapped() { return tapped; },
		get scrollStarted() { return scrollStarted; },
		get selectionCleared() { return selectionCleared; }
	};
}

type FakePointer = {
	pointerType: string;
	isPrimary: boolean;
	pointerId: number;
	clientY: number;
	target: unknown;
	defaultPrevented: boolean;
	preventDefault(): void;
};

function pointer(overrides: Partial<FakePointer> = {}): FakePointer {
	return {
		pointerType: 'touch',
		isPrimary: true,
		pointerId: 7,
		clientY: 80,
		target: null,
		defaultPrevented: false,
		preventDefault() { this.defaultPrevented = true; },
		...overrides
	};
}

test('keeps a short terminal touch available as a tap', () => {
	const target = fixture();
	target.fire('pointerdown', pointer());
	const move = pointer({ clientY: 75 });
	target.fire('pointermove', move);
	target.fire('pointerup', pointer({ clientY: 75 }));

	assert.equal(move.defaultPrevented, false);
	assert.equal(target.tapped, 1);
	assert.equal(target.scrollStarted, 0);
	assert.deepEqual(target.scrollLines, []);
});

test('turns an intentional drag into terminal scroll and suppresses its click', () => {
	const target = fixture();
	target.fire('pointerdown', pointer());
	target.fire('pointermove', pointer({ clientY: 76 }));
	const drag = pointer({ clientY: 58 });
	target.fire('pointermove', drag);
	target.fire('lostpointercapture', pointer({ clientY: 58, target: new StubElement() }));
	target.fire('pointermove', pointer({ clientY: 38 }));
	target.fire('pointerup', pointer({ clientY: 38 }));

	const mouse = {
		defaultPrevented: false,
		propagationStopped: false,
		preventDefault() { this.defaultPrevented = true; },
		stopPropagation() { this.propagationStopped = true; }
	};
	target.fire('mousedown', mouse);

	assert.equal(drag.defaultPrevented, true);
	assert.equal(target.capturedPointer, 7);
	assert.equal(target.scrollStarted, 1);
	assert.equal(target.tapped, 0);
	assert.equal(target.selectionCleared, 1);
	assert.deepEqual(target.scrollAttempts, [2, 2]);
	assert.deepEqual(target.scrollLines, [2, 2]);
	assert.equal(mouse.defaultPrevented, true);
	assert.equal(mouse.propagationStopped, true);
});

test('reports a downward drag as an attempt to reveal older terminal rows', () => {
	const target = fixture();
	target.fire('pointerdown', pointer({ clientY: 40 }));
	const drag = pointer({ clientY: 62 });
	target.fire('pointermove', drag);

	assert.equal(drag.defaultPrevented, true);
	assert.deepEqual(target.scrollAttempts, [-2]);
	assert.deepEqual(target.scrollLines, [-2]);
});
