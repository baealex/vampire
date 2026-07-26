import { cpus, freemem, totalmem } from 'node:os';
import type { SystemMetrics } from '$lib/system-metrics';

interface CpuSample {
	idle: number;
	total: number;
}

const MINIMUM_SAMPLE_INTERVAL_MS = 1_000;
let previousCpuSample = readCpuSample();
let previousSampleTime = Date.now();
let cachedMetrics: SystemMetrics | undefined;

function readCpuSample(): CpuSample {
	return cpus().reduce<CpuSample>((sample, cpu) => {
		const { idle, user, nice, sys, irq } = cpu.times;
		sample.idle += idle;
		sample.total += idle + user + nice + sys + irq;
		return sample;
	}, { idle: 0, total: 0 });
}

function percentage(value: number): number {
	return Math.min(100, Math.max(0, Math.round(value)));
}

export function getSystemMetrics(now = Date.now()): SystemMetrics {
	if (cachedMetrics && now - previousSampleTime < MINIMUM_SAMPLE_INTERVAL_MS) return cachedMetrics;

	const currentCpuSample = readCpuSample();
	const totalElapsed = currentCpuSample.total - previousCpuSample.total;
	const idleElapsed = currentCpuSample.idle - previousCpuSample.idle;
	const memoryTotalBytes = totalmem();
	const memoryUsedBytes = memoryTotalBytes - freemem();

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
