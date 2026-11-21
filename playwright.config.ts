import { chromium, defineConfig } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { StoryTapeTestOptions } from './e2e/fixtures';

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

const CHROMIUM_LAUNCH_ARGS = [
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
  '--no-sandbox',
  '--disable-dev-shm-usage',
];

function resolveSlowCpuLaunchOptions() {
  const baseExecutable = resolveChromiumExecutable();
  const realChromium = baseExecutable ?? chromium.executablePath();
  const wrapperPath = path.resolve('e2e/single-cpu-chromium.sh');

  if (
    process.platform === 'linux' &&
    realChromium &&
    fs.existsSync(realChromium) &&
    fs.existsSync('/usr/bin/taskset') &&
    fs.existsSync(wrapperPath)
  ) {
    const cleanEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) cleanEnv[k] = v;
    }
    cleanEnv.STORYTAPE_REAL_CHROMIUM = realChromium;
    return {
      executablePath: wrapperPath,
      args: CHROMIUM_LAUNCH_ARGS,
      env: cleanEnv,
    };
  }

  return {
    executablePath: baseExecutable,
    args: CHROMIUM_LAUNCH_ARGS,
  };
}

const PORT = Number(process.env.E2E_PORT || 4173);
const BASE_URL = `http://127.0.0.1:${PORT}/pwa_recorder/`;
const isStrictGate = Boolean(process.env.CI || process.env.PRECHECK);

export default defineConfig<StoryTapeTestOptions>({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: isStrictGate,
  retries: 0,
  workers: process.env.E2E_WORKERS
    ? Number(process.env.E2E_WORKERS)
    : process.env.CI
      ? Math.max(3, Math.min(4, os.cpus().length))
      : Math.max(4, Math.min(8, os.cpus().length * 2)),
  timeout: 45_000,
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
    cpuThrottleRate: Number(process.env.E2E_CPU_THROTTLE || '1'),
    launchOptions: {
      executablePath: resolveChromiumExecutable(),
      args: CHROMIUM_LAUNCH_ARGS,
    },
  },
  projects: [
    {
      name: 'mobile',
      testMatch: /cuj-.*\.spec\.ts/,
      use: {
        cpuThrottleRate: 1,
      },
    },
    {
      // Verifies narrow 360px phone layouts (including Drive-connected "Synced" / "N to sync"
      // header pills, Theme Switcher, Settings, ShareSheet, JoinShareModal, and Quality Lab) before push.
      name: 'mobile-compact',
      testMatch: /cuj-(01|06|08|09|10)-.*\.spec\.ts/,
      use: {
        viewport: { width: 360, height: 740 },
        cpuThrottleRate: 1,
      },
    },
    {
      // Deterministically reproduces slow mobile phones & contended CI runners locally
      // for real-time audio capture, live waveform rAF, scrub momentum, trim, and undo.
      name: 'mobile-slow-cpu',
      testMatch: /cuj-(02|03)-.*\.spec\.ts/,
      use: {
        cpuThrottleRate: 4,
        launchOptions: resolveSlowCpuLaunchOptions(),
      },
    },
  ],
  webServer: {
    command: `./node_modules/.bin/vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: !isStrictGate,
    timeout: 30_000,
  },
});
