import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '..');
const source = await readFile(resolve(root, 'src/lib/terminal/touch-scroll.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
	compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
}).outputText;
const touchScroll = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

class StubElement {}
globalThis.Element = StubElement;

function fixture() {
	const listeners = new Map();
	const scrollLines = [];
	let selectionCleared = 0;
	let scrollStarted = 0;
	let tapped = 0;
	let capturedPointer;
	const element = {
		clientHeight: 100,
		addEventListener(name, listener) {
			const registered = listeners.get(name) ?? [];
			registered.push(listener);
			listeners.set(name, registered);
		},
		removeEventListener() {},
		setPointerCapture(pointerId) { capturedPointer = pointerId; }
	};
	const terminal = {
		rows: 10,
		element: { querySelector: () => ({ getBoundingClientRect: () => ({ height: 100 }) }) },
		clearSelection() { selectionCleared += 1; },
		scrollLines(lines) { scrollLines.push(lines); }
	};
	touchScroll.installTerminalTouchScroll(element, () => terminal, {
		onScrollStart: () => { scrollStarted += 1; },
		onTap: () => { tapped += 1; }
	});
	const fire = (name, event) => {
		for (const listener of listeners.get(name) ?? []) listener(event);
	};
	return {
		fire,
		scrollLines,
		get capturedPointer() { return capturedPointer; },
		get tapped() { return tapped; },
		get scrollStarted() { return scrollStarted; },
		get selectionCleared() { return selectionCleared; }
	};
}

function pointer(overrides = {}) {
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
	assert.deepEqual(target.scrollLines, [2, 2]);
	assert.equal(mouse.defaultPrevented, true);
	assert.equal(mouse.propagationStopped, true);
});
