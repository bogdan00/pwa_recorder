#!/usr/bin/env node
/**
 * StoryTape Headless Chrome Recording Performance & Audio-Integrity Gate (ADR-04, ADR-09)
 *
 * Launches an isolated headless Chromium instance against the production `dist/` bundle
 * served via `vite preview` at `/pwa_recorder/` (390x844 @ 3x mobile DPR, fed a real
 * 440 Hz sine PCM stream via `--use-file-for-fake-audio-capture`) and:
 *   1. Verifies strict frame-pacing, CPU, DOM-churn, DPR-cap, opt-in keepalive,
 *      AudioWorklet, OLED Blackout rAF-pause, and zero-dropout PCM integrity budgets
 *      across both 1x CPU and 4x single-vCPU throttled profiles.
 *   2. Runs a fast live Regression-Detection Canary that injects the exact pre-fix bugs
 *      (60Hz CSS `pulse-ring` RecalcStyle animation + unconditional looping `<audio>`
 *      keepalive) into a throwaway page and proves this gate catches and fails on them.
 *   3. Prints a clear Pre-Submit Scorecard (and writes it to `$GITHUB_STEP_SUMMARY` in CI).
 */

import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildScorecardRows,
  evaluateProfileResults,
  formatScorecardMarkdown,
  formatScorecardText,
  PERF_PROFILES,
} from './perfBudgets.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const DIST_INDEX = path.join(REPO_ROOT, 'dist', 'index.html');

const CHROMIUM_LAUNCH_ARGS = [
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
  '--no-sandbox',
  '--disable-dev-shm-usage',
];

function createSineWavFile(filePath, durationSec = 16, sampleRate = 48000, freqHz = 440) {
  const numSamples = durationSec * sampleRate;
  const dataSize = numSamples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // Mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < numSamples; i += 1) {
    const s = Math.sin((2 * Math.PI * freqHz * i) / sampleRate) * 0.25;
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  fs.writeFileSync(filePath, buf);
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 4195;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function resolveChromiumExecutable() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
    return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  }
  if (process.env.CI) return undefined;
  const candidates = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'];
  return candidates.find((p) => fs.existsSync(p));
}

function resolveLaunchOptions(wavPath, cpuThrottle) {
  const args = [
    ...CHROMIUM_LAUNCH_ARGS,
    `--use-file-for-fake-audio-capture=${wavPath}`,
  ];
  const baseExecutable = resolveChromiumExecutable();

  // Match ADR-09 single-vCPU pinning on Linux when CDP CPU throttling is enabled so
  // Chromium's ThreadCPUThrottler SIGUSR2 handler never hits the 42.95s cross-vCPU hang.
  if (cpuThrottle > 1 && process.platform === 'linux') {
    const realChromium = baseExecutable ?? chromium.executablePath();
    const wrapperPath = path.join(REPO_ROOT, 'e2e', 'single-cpu-chromium.sh');
    if (
      realChromium &&
      fs.existsSync(realChromium) &&
      fs.existsSync('/usr/bin/taskset') &&
      fs.existsSync(wrapperPath)
    ) {
      const cleanEnv = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined) cleanEnv[k] = v;
      }
      cleanEnv.STORYTAPE_REAL_CHROMIUM = realChromium;
      return {
        headless: true,
        executablePath: wrapperPath,
        args,
        env: cleanEnv,
      };
    }
  }

  return {
    headless: true,
    executablePath: baseExecutable,
    args,
  };
}

function isAllowedLocalUrl(rawUrl) {
  if (
    rawUrl.startsWith('data:') ||
    rawUrl.startsWith('blob:') ||
    rawUrl.startsWith('about:')
  ) {
    return true;
  }
  try {
    const parsed = new URL(rawUrl);
    return (
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === 'localhost' ||
      parsed.hostname === '[::1]'
    );
  } catch {
    return false;
  }
}

/**
 * Starts `vite preview` and waits reactively by polling HTTP 200 on `baseUrl`
 * (immune to non-TTY stdout buffering on GitHub Actions CI runners).
 */
async function startPreviewServer(port, baseUrl) {
  const viteBin = path.join(REPO_ROOT, 'node_modules', '.bin', 'vite');
  const child = spawn(
    viteBin,
    ['preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let stderrBuf = '';
  let exitCode = null;
  child.stderr.on('data', (d) => {
    stderrBuf += d.toString();
  });
  child.on('exit', (code) => {
    exitCode = code;
  });

  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (exitCode !== null) {
      throw new Error(`vite preview exited early with code ${exitCode}.\n${stderrBuf}`);
    }
    try {
      const resp = await fetch(baseUrl);
      if (resp.ok) {
        return child;
      }
    } catch {
      // Server still binding; retry shortly
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  child.kill('SIGTERM');
  throw new Error(`Timed out waiting for vite preview HTTP 200 at ${baseUrl}.\n${stderrBuf}`);
}

function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return 0;
  const idx = Math.min(sortedArr.length - 1, Math.floor(sortedArr.length * p));
  return sortedArr[idx];
}

function mean(arr) {
  if (arr.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < arr.length; i += 1) sum += arr[i];
  return sum / arr.length;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

async function attachNetworkFence(context) {
  const unexpectedExternalUrls = [];
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    if (isAllowedLocalUrl(url)) {
      await route.continue();
      return;
    }
    try {
      const parsed = new URL(url);
      if (
        parsed.hostname === 'fonts.googleapis.com' ||
        parsed.hostname === 'fonts.gstatic.com'
      ) {
        await route.fulfill({
          status: 200,
          contentType:
            parsed.hostname === 'fonts.googleapis.com' ? 'text/css' : 'font/woff2',
          body: '',
        });
        return;
      }
      if (
        parsed.hostname === 'accounts.google.com' &&
        parsed.pathname === '/gsi/client'
      ) {
        await route.fulfill({
          status: 200,
          contentType: 'application/javascript',
          body: '// Stubbed GSI loader (offline/CI parity fence)\n',
        });
        return;
      }
    } catch {
      // Fall through to abort
    }
    unexpectedExternalUrls.push(`${route.request().method()} ${url}`);
    await route.abort('blockedbyclient');
  });
  return unexpectedExternalUrls;
}

async function attachProbeInitScript(page) {
  await page.addInitScript(() => {
    window.__STORYTAPE_AUTH_BROKER_URL__ = '';
    window.__perfProbe = {
      workletLoaded: 0,
      workletErrors: [],
      scriptProcessorCreated: 0,
      playbackLatencyHintCalls: 0,
      loopingAudioPlayCalls: 0,
      chunkCount: 0,
      chunkIntervals: [],
      lastChunkTs: 0,
      measuringChunks: false,
    };

    const origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...args) {
      if (this.loop) {
        window.__perfProbe.loopingAudioPlayCalls += 1;
      }
      return origPlay.apply(this, args);
    };

    const OrigAC = window.AudioContext;
    if (OrigAC) {
      window.AudioContext = function (...args) {
        const opts = args[0];
        if (opts && typeof opts === 'object' && opts.latencyHint === 'playback') {
          window.__perfProbe.playbackLatencyHintCalls += 1;
        }
        const ctx = new OrigAC(...args);
        if (ctx.audioWorklet && ctx.audioWorklet.addModule) {
          const origAdd = ctx.audioWorklet.addModule.bind(ctx.audioWorklet);
          ctx.audioWorklet.addModule = async (...a) => {
            try {
              const res = await origAdd(...a);
              window.__perfProbe.workletLoaded += 1;
              return res;
            } catch (err) {
              window.__perfProbe.workletErrors.push(String(err));
              throw err;
            }
          };
        }
        if (ctx.createScriptProcessor) {
          const origSP = ctx.createScriptProcessor.bind(ctx);
          ctx.createScriptProcessor = (...a) => {
            window.__perfProbe.scriptProcessorCreated += 1;
            return origSP(...a);
          };
        }
        return ctx;
      };
      window.AudioContext.prototype = OrigAC.prototype;
    }

    const OrigAWN = window.AudioWorkletNode;
    if (OrigAWN) {
      window.AudioWorkletNode = function (...args) {
        const node = new OrigAWN(...args);
        const port = node.port;
        const desc = Object.getOwnPropertyDescriptor(MessagePort.prototype, 'onmessage');
        if (desc && desc.set && desc.get) {
          Object.defineProperty(port, 'onmessage', {
            set(fn) {
              if (!fn) {
                desc.set.call(port, null);
                return;
              }
              desc.set.call(port, (ev) => {
                const probe = window.__perfProbe;
                const now = performance.now();
                probe.chunkCount += 1;
                if (probe.measuringChunks) {
                  if (probe.lastChunkTs > 0) {
                    probe.chunkIntervals.push(now - probe.lastChunkTs);
                  }
                  probe.lastChunkTs = now;
                }
                fn(ev);
              });
            },
            get() {
              return desc.get.call(port);
            },
            configurable: true,
          });
        }
        return node;
      };
      window.AudioWorkletNode.prototype = OrigAWN.prototype;
    }
  });
}

async function runProfile({ baseUrl, wavPath, profile }) {
  const { name, cpuThrottle, measureSeconds, checkBlackoutPause, budgets } = profile;

  const browser = await chromium.launch(resolveLaunchOptions(wavPath, cpuThrottle));
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3, // High-DPI phone viewport to enforce DPR <= 2 cap
    isMobile: true,
    hasTouch: true,
    permissions: ['microphone'],
  });

  const unexpectedExternalUrls = await attachNetworkFence(context);
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.message || String(err)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  await attachProbeInitScript(page);

  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  if (cpuThrottle > 1) {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuThrottle });
  }

  try {
    await page.goto(baseUrl, { waitUntil: 'networkidle' });

    // Create a book & enter Recording Studio
    await page.locator('#empty-new-book-btn, #new-book-fab').first().click();
    await page.locator('#book-title-input').fill(`Perf Gate ${name}`);
    await page.locator('#save-book-btn').click();
    await page.locator('#record-chapter-btn').click();
    await page.getByTestId('recording-studio-view').waitFor({ state: 'visible' });

    // Start live recording
    await page.locator('#big-record-pause-btn').click();
    await page.locator('.studio-status-pill', { hasText: 'REC' }).waitFor({ state: 'visible' });

    // Wait reactively for warmup (~20 audio worklet chunks = ~0.5s) before sampling steady-state metrics
    await page.waitForFunction(() => window.__perfProbe.chunkCount >= 20, { timeout: 10_000 });

    // Reset steady-state chunk interval tracking right before measurement window
    await page.evaluate(() => {
      window.__perfProbe.chunkIntervals = [];
      window.__perfProbe.lastChunkTs = 0;
      window.__perfProbe.measuringChunks = true;
    });

    const metricsBefore = await cdp.send('Performance.getMetrics');
    const windowResult = await page.evaluate((targetMs) => {
      return new Promise((resolve) => {
        const rafDeltas = [];
        let lastTs = 0;
        const startTs = performance.now();
        const startChunkCount = window.__perfProbe.chunkCount;

        const tick = (now) => {
          if (lastTs > 0) {
            rafDeltas.push(now - lastTs);
          }
          lastTs = now;
          const elapsed = now - startTs;
          if (elapsed >= targetMs) {
            window.__perfProbe.measuringChunks = false;
            const canvas = document.querySelector('.waveform-canvas');
            resolve({
              elapsedMs: elapsed,
              rafDeltas,
              windowChunks: window.__perfProbe.chunkCount - startChunkCount,
              canvasPixelWidth: canvas ? canvas.width : 0,
              canvasClientWidth: canvas ? canvas.clientWidth : 0,
            });
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    }, measureSeconds * 1000);
    const metricsAfter = await cdp.send('Performance.getMetrics');

    // Optional OLED Blackout check: canvas rAF must pause while audio capture keeps flowing
    let blackoutResult = null;
    if (checkBlackoutPause) {
      await page.getByTestId('blackout-mode-btn').click();
      await page.getByTestId('studio-blackout-overlay').waitFor({ state: 'visible' });
      blackoutResult = await page.evaluate(() => {
        return new Promise((resolve) => {
          const canvas = document.querySelector('.waveform-canvas');
          const startRenders = canvas?.__renderCount ?? 0;
          const startChunks = window.__perfProbe.chunkCount;
          const startTs = performance.now();
          const check = (now) => {
            if (now - startTs >= 800) {
              resolve({
                canvasRenderDelta: (canvas?.__renderCount ?? 0) - startRenders,
                chunkDelta: window.__perfProbe.chunkCount - startChunks,
              });
              return;
            }
            requestAnimationFrame(check);
          };
          requestAnimationFrame(check);
        });
      });
      // Wake blackout (double tap) before pausing
      await page.getByTestId('studio-blackout-overlay').click();
      await page.getByTestId('studio-blackout-overlay').click();
      await page.getByTestId('studio-blackout-overlay').waitFor({ state: 'hidden' });
    }

    // Pause recording so all pending PCM chunks flush atomically into IndexedDB
    await page.locator('#big-record-pause-btn').click();
    await page.locator('.studio-status-pill', { hasText: 'PAUSED' }).waitFor({ state: 'visible' });

    // Read persisted PCM draft from IndexedDB and verify zero silent dropout runs
    const probeAndAudio = await page.evaluate(async () => {
      const readDraft = async () => {
        const db = await new Promise((resolve, reject) => {
          const req = indexedDB.open('storytape-db', 2);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        try {
          const tx = db.transaction(['drafts', 'draftChunks'], 'readonly');
          const drafts = await new Promise((res, rej) => {
            const r = tx.objectStore('drafts').getAll();
            r.onsuccess = () => res(r.result);
            r.onerror = () => rej(r.error);
          });
          const chunks = await new Promise((res, rej) => {
            const r = tx.objectStore('draftChunks').getAll();
            r.onsuccess = () => res(r.result);
            r.onerror = () => rej(r.error);
          });
          return { drafts, chunks };
        } finally {
          db.close();
        }
      };

      let snapshot = await readDraft();
      const pollStart = performance.now();
      while (snapshot.chunks.length === 0 && performance.now() - pollStart < 3000) {
        await new Promise((r) => requestAnimationFrame(r));
        snapshot = await readDraft();
      }

      const { drafts, chunks } = snapshot;
      chunks.sort((a, b) => a.chunkIndex - b.chunkIndex);
      let totalSamples = 0;
      for (const c of chunks) totalSamples += c.data.length;
      const merged = new Float32Array(totalSamples);
      let offset = 0;
      for (const c of chunks) {
        merged.set(c.data, offset);
        offset += c.data.length;
      }

      const sampleRate = drafts[0]?.sampleRate || 48000;
      const recordedDurationSec = merged.length / sampleRate;

      const trimStart = Math.min(Math.floor(sampleRate * 0.15), merged.length);
      const trimEnd = Math.max(trimStart, merged.length - Math.floor(sampleRate * 0.05));

      let zeroRuns = 0;
      let maxZeroRun = 0;
      let curZeroRun = 0;
      let maxAbs = 0;

      for (let i = trimStart; i < trimEnd; i += 1) {
        const av = Math.abs(merged[i]);
        if (av > maxAbs) maxAbs = av;
        if (av < 1e-6) {
          curZeroRun += 1;
          if (curZeroRun > maxZeroRun) maxZeroRun = curZeroRun;
        } else {
          if (curZeroRun >= 32) zeroRuns += 1;
          curZeroRun = 0;
        }
      }
      if (curZeroRun >= 32) zeroRuns += 1;

      return {
        probe: window.__perfProbe,
        sampleRate,
        recordedDurationSec,
        zeroRuns,
        maxZeroRun,
        maxAbs,
      };
    });

    const m1 = Object.fromEntries(metricsBefore.metrics.map((m) => [m.name, m.value]));
    const m2 = Object.fromEntries(metricsAfter.metrics.map((m) => [m.name, m.value]));
    const elapsedSec = windowResult.elapsedMs / 1000;

    const sortedRaf = [...windowResult.rafDeltas].sort((a, b) => a - b);
    const sortedChunks = [...probeAndAudio.probe.chunkIntervals].sort((a, b) => a - b);

    const summary = {
      name,
      cpuThrottle,
      fps: round1(windowResult.rafDeltas.length / elapsedSec),
      p50FrameMs: round1(percentile(sortedRaf, 0.5)),
      p95FrameMs: round1(percentile(sortedRaf, 0.95)),
      maxFrameMs: round1(percentile(sortedRaf, 1)),
      severeStalls: windowResult.rafDeltas.filter((d) => d > 50).length,
      scriptMsPerSec: round1(((m2.ScriptDuration - m1.ScriptDuration) * 1000) / elapsedSec),
      taskMsPerSec: round1(((m2.TaskDuration - m1.TaskDuration) * 1000) / elapsedSec),
      recalcStylePerSec: round1((m2.RecalcStyleCount - m1.RecalcStyleCount) / elapsedSec),
      layoutPerSec: round1((m2.LayoutCount - m1.LayoutCount) / elapsedSec),
      workletLoaded: probeAndAudio.probe.workletLoaded,
      scriptProcessorCreated: probeAndAudio.probe.scriptProcessorCreated,
      playbackLatencyHintCalls: probeAndAudio.probe.playbackLatencyHintCalls,
      loopingAudioPlayCalls: probeAndAudio.probe.loopingAudioPlayCalls,
      playheadStallFrames: windowResult.playheadStallFrames,
      playheadJumpFrames: windowResult.playheadJumpFrames,
      maxPlayheadStepMs: round1(windowResult.maxPlayheadStepMs),
      windowChunks: windowResult.windowChunks,
      meanChunkIntervalMs: round1(mean(sortedChunks)),
      maxChunkIntervalMs: round1(percentile(sortedChunks, 1)),
      canvasPixelWidth: windowResult.canvasPixelWidth,
      canvasClientWidth: windowResult.canvasClientWidth,
      recordedDurationSec: round1(probeAndAudio.recordedDurationSec),
      zeroRuns: probeAndAudio.zeroRuns,
      maxAbs: Math.round(probeAndAudio.maxAbs * 10000) / 10000,
      blackoutResult,
    };

    const failures = evaluateProfileResults(summary, budgets, {
      pageErrors,
      consoleErrors,
      unexpectedExternalUrls,
      workletErrors: probeAndAudio.probe.workletErrors,
      maxZeroRun: probeAndAudio.maxZeroRun,
    });

    return { summary, failures };
  } finally {
    if (cpuThrottle > 1) {
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }).catch(() => {});
    }
    await cdp.detach().catch(() => {});
    await browser.close();
  }
}

/**
 * Live Regression-Detection Canary (~2s):
 * Injects the two exact pre-fix regressions into a throwaway headless Chrome page:
 *   1) The 60Hz `.record-btn-halo { animation: pulse-ring ... }` CSS animation, and
 *   2) Enabling `backgroundRecordingKeepalive: true` (unconditional looping `<audio>`).
 * Proves that `evaluateProfileResults` catches and FAILS on BOTH regressions live.
 */
async function runRegressionCanary({ baseUrl, wavPath }) {
  const browser = await chromium.launch(resolveLaunchOptions(wavPath, 1));
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    permissions: ['microphone'],
  });
  await attachNetworkFence(context);
  const page = await context.newPage();
  await attachProbeInitScript(page);

  // Inject Bug #1 (unconditional looping keepalive enabled by default) via persisted settings
  await page.addInitScript(() => {
    window.localStorage.setItem(
      'storytape.settings.v1',
      JSON.stringify({ backgroundRecordingKeepalive: true }),
    );
  });

  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');

  try {
    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await page.locator('#empty-new-book-btn, #new-book-fab').first().click();
    await page.locator('#book-title-input').fill('Regression Canary');
    await page.locator('#save-book-btn').click();
    await page.locator('#record-chapter-btn').click();
    await page.getByTestId('recording-studio-view').waitFor({ state: 'visible' });

    // Inject Bug #2 (60Hz main-thread RecalcStyle infinite pulse-ring animation)
    await page.addStyleTag({
      content: '.record-btn-halo { animation: pulse-ring 1.8s var(--ease-out) infinite !important; }',
    });

    await page.locator('#big-record-pause-btn').click();
    await page.locator('.studio-status-pill', { hasText: 'REC' }).waitFor({ state: 'visible' });
    await page.waitForFunction(() => window.__perfProbe.chunkCount >= 10, { timeout: 10_000 });

    const mBefore = await cdp.send('Performance.getMetrics');
    const elapsedMs = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const start = performance.now();
          const tick = (now) => {
            if (now - start >= 1500) {
              resolve(now - start);
              return;
            }
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }),
    );
    const mAfter = await cdp.send('Performance.getMetrics');
    const probe = await page.evaluate(() => window.__perfProbe);

    const m1 = Object.fromEntries(mBefore.metrics.map((m) => [m.name, m.value]));
    const m2 = Object.fromEntries(mAfter.metrics.map((m) => [m.name, m.value]));
    const recalcStylePerSec = round1(
      (m2.RecalcStyleCount - m1.RecalcStyleCount) / (elapsedMs / 1000),
    );

    const syntheticSummary = {
      fps: 60,
      p95FrameMs: 16.7,
      severeStalls: 0,
      scriptMsPerSec: 30,
      recalcStylePerSec,
      layoutPerSec: 10,
      workletLoaded: probe.workletLoaded,
      scriptProcessorCreated: probe.scriptProcessorCreated,
      loopingAudioPlayCalls: probe.loopingAudioPlayCalls,
      windowChunks: 200,
      meanChunkIntervalMs: 25,
      maxChunkIntervalMs: 50,
      canvasPixelWidth: 712,
      canvasClientWidth: 356,
      recordedDurationSec: 5,
      zeroRuns: 0,
      maxAbs: 0.2,
    };

    const caught = evaluateProfileResults(syntheticSummary, PERF_PROFILES[0].budgets);
    const caughtRecalc = caught.some((f) => /RecalcStyle/i.test(f));
    const caughtKeepalive = caught.some((f) => /keepalive/i.test(f));
    const caughtCount = (caughtRecalc ? 1 : 0) + (caughtKeepalive ? 1 : 0);

    return {
      passed: caughtRecalc && caughtKeepalive,
      caughtCount,
      caughtRecalc,
      caughtKeepalive,
      recalcStylePerSec,
      loopingAudioPlayCalls: probe.loopingAudioPlayCalls,
      failures: [
        ...(!caughtRecalc
          ? [`Canary failed to catch injected 60Hz RecalcStyle animation (measured ${recalcStylePerSec}/s)`]
          : []),
        ...(!caughtKeepalive
          ? [`Canary failed to catch injected looping keepalive <audio> (measured ${probe.loopingAudioPlayCalls} plays)`]
          : []),
      ],
    };
  } finally {
    await cdp.detach().catch(() => {});
    await browser.close();
  }
}

async function main() {
  if (!fs.existsSync(DIST_INDEX)) {
    console.error(
      'ERROR: dist/index.html not found. Run `npm run build` before `npm run test:perf`.',
    );
    process.exit(1);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storytape-perf-'));
  const wavPath = path.join(tmpDir, 'sine440.wav');
  createSineWavFile(wavPath, 16, 48000, 440);

  const port = process.env.PERF_PORT ? Number(process.env.PERF_PORT) : await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}/pwa_recorder/`;
  const server = await startPreviewServer(port, baseUrl);

  let allPassed = true;
  const summaries = [];
  let canary = null;

  try {
    for (const profile of PERF_PROFILES) {
      const { summary, failures } = await runProfile({ baseUrl, wavPath, profile });
      summaries.push(summary);
      if (failures.length > 0) {
        allPassed = false;
        console.error(`\n[FAIL] ${summary.name}:`);
        for (const f of failures) {
          console.error(`  ✗ ${f}`);
        }
      }
    }

    canary = await runRegressionCanary({ baseUrl, wavPath });
    if (!canary.passed) {
      allPassed = false;
      console.error('\n[FAIL] Live Regression-Detection Canary:');
      for (const f of canary.failures) {
        console.error(`  ✗ ${f}`);
      }
    }
  } finally {
    server.kill('SIGTERM');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  if (summaries.length >= 2) {
    const rows = buildScorecardRows(summaries[0], summaries[1], canary);
    console.log(formatScorecardText(rows));

    if (process.env.GITHUB_STEP_SUMMARY) {
      try {
        fs.appendFileSync(
          process.env.GITHUB_STEP_SUMMARY,
          `\n${formatScorecardMarkdown(rows)}\n`,
        );
      } catch {
        // Non-fatal if summary path is unwritable
      }
    }
  }

  console.log('');
  if (!allPassed) {
    console.error('Headless Chrome performance gate FAILED.');
    process.exit(1);
  }
  console.log('Headless Chrome performance gate PASSED (all budgets + live regression canary verified).');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
