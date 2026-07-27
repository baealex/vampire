import { cpus, freemem, totalmem } from 'node:os';

const MINIMUM_SAMPLE_INTERVAL_MS = 1_000;

/** @typedef {{ cpuUsage: number; memoryUsage: number; memoryUsedBytes: number; memoryTotalBytes: number }} SystemMetrics */
/** @typedef {{ idle: number; total: number }} CpuSample */

let previousCpuSample = readCpuSample();
let previousSampleTime = Date.now();
/** @type {SystemMetrics | undefined} */
let cachedMetrics;

/** @returns {CpuSample} */
function readCpuSample() {
	return cpus().reduce((sample, cpu) => {
		const { idle, user, nice, sys, irq } = cpu.times;
		sample.idle += idle;
		sample.total += idle + user + nice + sys + irq;
		return sample;
	}, { idle: 0, total: 0 });
}

/** @param {number} value */
function percentage(value) {
	return Math.min(100, Math.max(0, Math.round(value)));
}

function readMemoryUsage() {
	const constrainedMemory = typeof process.constrainedMemory === 'function'
		? process.constrainedMemory()
		: 0;
	const memoryTotalBytes = constrainedMemory > 0 ? constrainedMemory : totalmem();
	const memoryAvailableBytes = typeof process.availableMemory === 'function'
		? process.availableMemory()
		: freemem();
	const boundedAvailableBytes = Math.min(memoryTotalBytes, Math.max(0, memoryAvailableBytes));

	return {
		memoryTotalBytes,
		memoryUsedBytes: Math.max(0, memoryTotalBytes - boundedAvailableBytes)
	};
}

/** @param {number} [now] @returns {SystemMetrics} */
export function getSystemMetrics(now = Date.now()) {
	if (cachedMetrics && now - previousSampleTime < MINIMUM_SAMPLE_INTERVAL_MS) return cachedMetrics;

	const currentCpuSample = readCpuSample();
	const totalElapsed = currentCpuSample.total - previousCpuSample.total;
	const idleElapsed = currentCpuSample.idle - previousCpuSample.idle;
	const { memoryTotalBytes, memoryUsedBytes } = readMemoryUsage();

	previousCpuSample = currentCpuSample;
	previousSampleTime = now;
	cachedMetrics = {
		cpuUsage: totalElapsed > 0 ? percentage((1 - idleElapsed / totalElapsed) * 100) : 0,
		memoryUsage: memoryTotalBytes > 0 ? percentage((memoryUsedBytes / memoryTotalBytes) * 100) : 0,
		memoryUsedBytes,
		memoryTotalBytes
	};
	return cachedMetrics;
}
