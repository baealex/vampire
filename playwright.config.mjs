import { defineConfig, devices } from '@playwright/test';
import { E2E_BASE_URL } from './scripts/e2e-runtime.mjs';

export default defineConfig({
	testDir: './e2e',
	outputDir: 'test-results/playwright',
	globalTeardown: './e2e/global-teardown.mjs',
	fullyParallel: false,
	forbidOnly: Boolean(process.env.CI),
	retries: process.env.CI ? 1 : 0,
	workers: 1,
	reporter: 'line',
	use: {
		baseURL: E2E_BASE_URL,
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure'
	},
	projects: [
		{
			name: 'desktop-chromium',
			testMatch: '**/desktop.spec.mjs',
			use: { ...devices['Desktop Chrome'] }
		},
		{
			name: 'mobile-chromium',
			testMatch: '**/mobile.spec.mjs',
			use: { ...devices['Pixel 7'] }
		}
	],
	webServer: {
		command: 'node scripts/e2e-server.mjs',
		url: `${E2E_BASE_URL}/health`,
		reuseExistingServer: false,
		timeout: 120_000,
		gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
		stdout: 'pipe',
		stderr: 'pipe'
	}
});
