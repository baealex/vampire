export const SYSTEM_METRICS_INTERVAL_MS = 2_000;

export interface SystemMetrics {
	cpuUsage: number;
	memoryUsage: number;
	memoryUsedBytes: number;
	memoryTotalBytes: number;
}
