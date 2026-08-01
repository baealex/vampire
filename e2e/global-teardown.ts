import { cleanE2ERuntime } from './runtime.ts';

export default async function globalTeardown(): Promise<void> {
	await cleanE2ERuntime();
}
