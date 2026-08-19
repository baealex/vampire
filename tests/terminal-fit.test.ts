import assert from 'node:assert/strict';
import test from 'node:test';
import {
	fitTerminalToVisibleArea,
	terminalSizeForVisibleArea,
	type TerminalFitDimensions
} from '../src/lib/terminal/fit.ts';

function createFitAddon(dimensions: TerminalFitDimensions | undefined) {
	let fits = 0;
	return {
		addon: {
			proposeDimensions: () => dimensions,
			fit: () => { fits += 1; }
		},
		get fits() { return fits; }
	};
}

test('does not fit a terminal while its container has a transient tiny size', () => {
	for (const dimensions of [undefined, { cols: 2, rows: 1 }, { cols: 80, rows: 4 }]) {
		const harness = createFitAddon(dimensions);
		assert.equal(fitTerminalToVisibleArea(harness.addon), undefined);
		assert.equal(harness.fits, 0);
	}
});

test('fits and reports a stable terminal size', () => {
	const harness = createFitAddon({ cols: 120, rows: 36 });
	assert.deepEqual(fitTerminalToVisibleArea(harness.addon), { columns: 120, rows: 36 });
	assert.equal(harness.fits, 1);
});

test('caps an oversized terminal before it reaches the wire protocol', () => {
	const harness = createFitAddon({ cols: 900, rows: 400 });
	let resized: TerminalFitDimensions | undefined;
	assert.deepEqual(
		fitTerminalToVisibleArea(harness.addon, (cols, rows) => { resized = { cols, rows }; }),
		{ columns: 512, rows: 256 }
	);
	assert.equal(harness.fits, 0);
	assert.deepEqual(resized, { cols: 512, rows: 256 });
});

test('measures a viewer without changing its authoritative terminal geometry', () => {
	const harness = createFitAddon({ cols: 52, rows: 18 });
	assert.deepEqual(terminalSizeForVisibleArea(harness.addon), { columns: 52, rows: 18 });
	assert.equal(harness.fits, 0);
});

test('rejects non-finite terminal dimensions', () => {
	for (const dimensions of [{ cols: Number.NaN, rows: 24 }, { cols: 80, rows: Number.NaN }]) {
		const harness = createFitAddon(dimensions);
		assert.equal(fitTerminalToVisibleArea(harness.addon), undefined);
		assert.equal(harness.fits, 0);
	}
});
