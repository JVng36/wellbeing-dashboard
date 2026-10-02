import { defineConfig } from '@playwright/test';

const executablePath = process.env.WELLBEING_BROWSER_EXECUTABLE;

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: process.env.WELLBEING_E2E_ARTIFACT_DIR ?? `${process.env.TMPDIR ?? '/tmp'}/wellbeing-e2e-artifacts`,
  timeout: 30_000,
  use: { baseURL: `http://127.0.0.1:${process.env.WELLBEING_E2E_PORT ?? '8799'}`, trace: 'off', video: 'off', screenshot: 'off', launchOptions: executablePath ? { executablePath } : undefined },
  webServer: {
    command: 'node scripts/e2e-server.mjs',
    url: `http://127.0.0.1:${process.env.WELLBEING_E2E_PORT ?? '8799'}/api/v1/health`,
    reuseExistingServer: false,
    env: { WELLBEING_HOST: '127.0.0.1', WELLBEING_PORT: process.env.WELLBEING_E2E_PORT ?? '8799', WELLBEING_DATA_DIR: process.env.WELLBEING_E2E_DATA_DIR ?? '', NODE_ENV: 'test' }
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium', viewport: { width: 390, height: 844 } } }]
});
