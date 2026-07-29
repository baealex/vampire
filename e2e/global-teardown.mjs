import { cleanE2ERuntime } from '../scripts/e2e-runtime.mjs';

export default async function globalTeardown() {
	await cleanE2ERuntime();
}
