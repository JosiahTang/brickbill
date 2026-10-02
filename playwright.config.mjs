import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';

const apiPort = 5184;
const webPort = 5183;
const baseURL = `http://127.0.0.1:${webPort}`;

export default defineConfig({
  testDir: './e2e',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  outputDir: 'test-results',
  use: {
    ...devices['Desktop Chrome'], baseURL,
    trace: 'retain-on-failure', screenshot: 'only-on-failure', video: 'retain-on-failure',
    acceptDownloads: true,
  },
  webServer: [{
    command: 'node --experimental-strip-types server/main.ts',
    url: `http://127.0.0.1:${apiPort}/api/health`,
    timeout: 60_000,
    reuseExistingServer: !process.env.CI,
    env: {
      REPORTING_MODE: 'development', REPORTING_HOST: '127.0.0.1', REPORTING_PORT: String(apiPort),
      REPORTING_DATA_DIR: resolve('.runtime-test/e2e'), REPORTING_DEMO_PROJECTS: 'enabled',
      REPORTING_TOKENS_JSON: '', REPORTING_PROJECTS_FILE: '',
      REPORTING_PDF_PYTHON: process.env.REPORTING_PDF_PYTHON ?? '',
      REPORTING_PDF_FALLBACK_FONT: process.env.REPORTING_PDF_FALLBACK_FONT ?? '',
      REPORTING_PDF_ENABLED_PROJECTS: process.env.REPORTING_PDF_PYTHON && process.env.REPORTING_PDF_FALLBACK_FONT ? 'dalipu-demo' : '',
    },
  }, {
    command: `node node_modules/vite/bin/vite.js --host 127.0.0.1 --port ${webPort} --strictPort`,
    url: baseURL,
    timeout: 60_000,
    reuseExistingServer: !process.env.CI,
    env: { REPORTING_DEV_API_URL: `http://127.0.0.1:${apiPort}` },
  }],
});
