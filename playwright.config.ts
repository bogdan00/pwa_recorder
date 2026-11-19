import { defineConfig } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';

function resolveChromiumExecutable(): string | undefined {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
    return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  }
  // In GitHub Actions / when Playwright's own browser is installed, let Playwright pick it.
  // Otherwise fall back to preinstalled system Chromium if available.
  if (process.env.CI) return undefined;
  const candidates = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'];
  return candidates.find((p) => fs.existsSync(p));
}

const PORT = Number(process.env.E2E_PORT || 4173);
const BASE_URL = `http://127.0.0.1:${PORT}/pwa_recorder/`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.E2E_WORKERS
    ? Number(process.env.E2E_WORKERS)
    : Math.max(4, Math.min(10, os.cpus().length)),
  timeout: 40_000,
  expect: {
    timeout: 8_000,
  },
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never' }]]
    : [['list']],
  use: {
    baseURL: BASE_URL,
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    permissions: ['microphone'],
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: {
      executablePath: resolveChromiumExecutable(),
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
        '--no-sandbox',
        '--disable-dev-shm-usage',
      ],
    },
  },
  webServer: {
    command: `./node_modules/.bin/vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
