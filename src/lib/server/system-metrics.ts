import { getSystemMetrics as readSystemMetrics } from './system-metrics.mjs';
import type { SystemMetrics } from '$lib/system-metrics';

export function getSystemMetrics(now = Date.now()): SystemMetrics {
	return readSystemMetrics(now);
}
