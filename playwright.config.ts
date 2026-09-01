import { defineConfig, devices } from '@playwright/test';
import { E2E_BASE_URL } from './e2e/runtime.ts';

export default defineConfig({
  testDir: './e2e',
  outputDir: 'test-results/playwright',
  globalTeardown: './e2e/global-teardown.ts',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  workers: 1,
  reporter: 'line',
  use: {
    baseURL: E2E_BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'desktop-chromium',
      testMatch: '**/desktop.spec.ts',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'terminal-handoff-firefox',
      testMatch: '**/desktop.spec.ts',
      grep: /hands terminal layout between entered devices and restores it on disconnect/,
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'mobile-chromium',
      testMatch: '**/mobile.spec.ts',
      use: { ...devices['Pixel 7'] },
    },
    {
      name: 'mobile-firefox',
      testMatch: '**/mobile.spec.ts',
      use: {
        ...devices['Desktop Firefox'],
        viewport: { width: 412, height: 915 },
        deviceScaleFactor: 2,
        hasTouch: true,
        userAgent: 'Mozilla/5.0 (Android 15; Mobile; rv:141.0) Gecko/141.0 Firefox/141.0',
      },
    },
    {
      name: 'mobile-webkit',
      testMatch: '**/mobile.spec.ts',
      use: { ...devices['iPhone 15 Pro'] },
    },
  ],
  webServer: {
    command: 'node tools/e2e-server.ts',
    url: `${E2E_BASE_URL}/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
