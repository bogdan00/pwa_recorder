#!/usr/bin/env node
/**
 * StoryTape Headless Chrome Recording Performance & Audio-Integrity Gate (ADR-04, ADR-09)
 *
 * Launches an isolated headless Chromium instance against the production `dist/` bundle
 * served via `vite preview` at `/pwa_recorder/` (390x844 @ 3x mobile DPR, fed a real
 * 440 Hz sine PCM stream via `--use-file-for-fake-audio-capture`) and enforces strict
 * frame-pacing, CPU, DOM-churn, DPR-cap, opt-in keepalive, AudioWorklet, blackout-pause,
 * and zero-dropout PCM integrity budgets across both 1x CPU and 4x CPU-throttled profiles.
 */

import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

function startPreviewServer(port) {
  return new Promise((resolve, reject) => {
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
    const deadline = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Timed out starting vite preview on port ${port}.\n${stderrBuf}`));
    }, 20_000);

    const onReady = (chunk) => {
      const text = chunk.toString();
      if (text.includes(`:${port}`) || text.includes('Local:')) {
        clearTimeout(deadline);
        child.stdout.off('data', onReady);
        resolve(child);
      }
    };

    child.stdout.on('data', onReady);
    child.stderr.on('data', (d) => {
      stderrBuf += d.toString();
    });
    child.on('exit', (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(deadline);
        reject(new Error(`vite preview exited early with code ${code}.\n${stderrBuf}`));
      }
    });
  });
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

async function runProfile({ baseUrl, wavPath, profile }) {
  const {
    name,
    cpuThrottle,
    measureSeconds,
    checkBlackoutPause,
    budgets,
  } = profile;

  const browser = await chromium.launch(resolveLaunchOptions(wavPath, cpuThrottle));
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3, // High-DPI phone viewport to enforce DPR <= 2 cap
    isMobile: true,
    hasTouch: true,
    permissions: ['microphone'],
  });

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

  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.message || String(err)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  await page.addInitScript(() => {
    window.__STORYTAPE_AUTH_BROKER_URL__ = '';
    window.__perfProbe = {
      workletLoaded: 0,
      workletErrors: [],
      scriptProcessorCreated: 0,
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
              timerText:
                document.querySelector('[data-testid="studio-timer"]')?.textContent?.trim() || '',
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

    // Wait for draft metadata & chunks to settle in IndexedDB and verify PCM continuity
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

      // Poll via rAF until paused draft flush finishes writing chunks
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

      // Inspect steady interior PCM (excluding initial startup & final 15ms pause fade-out)
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
        chunkRecords: chunks.length,
        zeroRuns,
        maxZeroRun,
        maxAbs,
      };
    });

    const m1 = Object.fromEntries(metricsBefore.metrics.map((m) => [m.name, m.value]));
    const m2 = Object.fromEntries(metricsAfter.metrics.map((m) => [m.name, m.value]));
    const elapsedSec = windowResult.elapsedMs / 1000;

    const sortedRaf = [...windowResult.rafDeltas].sort((a, b) => a - b);
    const fps = windowResult.rafDeltas.length / elapsedSec;
    const p50FrameMs = percentile(sortedRaf, 0.5);
    const p95FrameMs = percentile(sortedRaf, 0.95);
    const maxFrameMs = percentile(sortedRaf, 1);
    const severeStalls = windowResult.rafDeltas.filter((d) => d > 50).length;

    const sortedChunks = [...probeAndAudio.probe.chunkIntervals].sort((a, b) => a - b);
    const meanChunkIntervalMs = mean(sortedChunks);
    const maxChunkIntervalMs = percentile(sortedChunks, 1);

    const scriptMsPerSec = ((m2.ScriptDuration - m1.ScriptDuration) * 1000) / elapsedSec;
    const taskMsPerSec = ((m2.TaskDuration - m1.TaskDuration) * 1000) / elapsedSec;
    const recalcStylePerSec = (m2.RecalcStyleCount - m1.RecalcStyleCount) / elapsedSec;
    const layoutPerSec = (m2.LayoutCount - m1.LayoutCount) / elapsedSec;

    const summary = {
      name,
      cpuThrottle,
      fps: round1(fps),
      p50FrameMs: round1(p50FrameMs),
      p95FrameMs: round1(p95FrameMs),
      maxFrameMs: round1(maxFrameMs),
      severeStalls,
      scriptMsPerSec: round1(scriptMsPerSec),
      taskMsPerSec: round1(taskMsPerSec),
      recalcStylePerSec: round1(recalcStylePerSec),
      layoutPerSec: round1(layoutPerSec),
      workletLoaded: probeAndAudio.probe.workletLoaded,
      scriptProcessorCreated: probeAndAudio.probe.scriptProcessorCreated,
      loopingAudioPlayCalls: probeAndAudio.probe.loopingAudioPlayCalls,
      windowChunks: windowResult.windowChunks,
      meanChunkIntervalMs: round1(meanChunkIntervalMs),
      maxChunkIntervalMs: round1(maxChunkIntervalMs),
      canvasPixelWidth: windowResult.canvasPixelWidth,
      canvasClientWidth: windowResult.canvasClientWidth,
      recordedDurationSec: round1(probeAndAudio.recordedDurationSec),
      zeroRuns: probeAndAudio.zeroRuns,
      maxAbs: Math.round(probeAndAudio.maxAbs * 10000) / 10000,
      blackoutResult,
    };

    const failures = [];
    const check = (cond, msg) => {
      if (!cond) failures.push(msg);
    };

    check(pageErrors.length === 0, `Uncaught pageerror(s): ${pageErrors.join(' | ')}`);
    check(consoleErrors.length === 0, `console.error(s): ${consoleErrors.join(' | ')}`);
    check(
      unexpectedExternalUrls.length === 0,
      `Unexpected external requests: ${unexpectedExternalUrls.join(', ')}`,
    );
    check(
      summary.workletLoaded === 1 &&
        summary.scriptProcessorCreated === 0 &&
        probeAndAudio.probe.workletErrors.length === 0,
      `Expected off-main-thread AudioWorklet (loaded=${summary.workletLoaded}, scriptProcessor=${summary.scriptProcessorCreated}, errors=${JSON.stringify(probeAndAudio.probe.workletErrors)})`,
    );
    check(
      summary.loopingAudioPlayCalls === 0,
      `Opt-in iOS looping <audio> keepalive must stay OFF by default (got ${summary.loopingAudioPlayCalls} play calls)`,
    );
    check(
      summary.canvasClientWidth > 0 &&
        summary.canvasPixelWidth <= Math.ceil(summary.canvasClientWidth * 2) + 2,
      `Canvas DPR must stay capped <= 2 on 3x devices (pixelWidth=${summary.canvasPixelWidth}, clientWidth=${summary.canvasClientWidth})`,
    );
    check(
      summary.fps >= budgets.minFps,
      `FPS ${summary.fps} fell below budget >= ${budgets.minFps}`,
    );
    check(
      summary.p95FrameMs <= budgets.maxP95FrameMs,
      `p95 frame time ${summary.p95FrameMs}ms exceeded budget <= ${budgets.maxP95FrameMs}ms`,
    );
    check(
      summary.severeStalls <= budgets.maxSevereStalls,
      `Severe frame stalls (>50ms): ${summary.severeStalls} exceeded budget <= ${budgets.maxSevereStalls}`,
    );
    check(
      summary.scriptMsPerSec <= budgets.maxScriptMsPerSec,
      `Main-thread script CPU ${summary.scriptMsPerSec}ms/s exceeded budget <= ${budgets.maxScriptMsPerSec}ms/s`,
    );
    check(
      summary.recalcStylePerSec <= budgets.maxRecalcStylePerSec,
      `RecalcStyle rate ${summary.recalcStylePerSec}/s exceeded budget <= ${budgets.maxRecalcStylePerSec}/s (60Hz CSS animation regression?)`,
    );
    check(
      summary.layoutPerSec <= budgets.maxLayoutPerSec,
      `Layout rate ${summary.layoutPerSec}/s exceeded budget <= ${budgets.maxLayoutPerSec}/s`,
    );
    check(
      summary.windowChunks >= budgets.minWindowChunks,
      `Worklet chunks captured (${summary.windowChunks}) fell below >= ${budgets.minWindowChunks}`,
    );
    check(
      summary.meanChunkIntervalMs >= 18 && summary.meanChunkIntervalMs <= 35,
      `Mean worklet chunk interval ${summary.meanChunkIntervalMs}ms outside healthy [18, 35]ms range`,
    );
    check(
      summary.maxChunkIntervalMs <= budgets.maxChunkIntervalMs,
      `Max worklet chunk gap ${summary.maxChunkIntervalMs}ms exceeded budget <= ${budgets.maxChunkIntervalMs}ms`,
    );
    check(
      summary.recordedDurationSec >= budgets.minRecordedSec,
      `Persisted PCM duration ${summary.recordedDurationSec}s fell below >= ${budgets.minRecordedSec}s`,
    );
    check(
      summary.zeroRuns === 0,
      `Detected ${summary.zeroRuns} silent PCM dropout run(s) >= 32 samples (maxZeroRun=${probeAndAudio.maxZeroRun})`,
    );
    check(
      summary.maxAbs >= 0.05,
      `Captured PCM amplitude too low (maxAbs=${summary.maxAbs}); expected live sine audio`,
    );

    if (blackoutResult) {
      check(
        blackoutResult.chunkDelta >= 15,
        `Blackout Mode interrupted audio capture (only ${blackoutResult.chunkDelta} chunks in 0.8s)`,
      );
      check(
        blackoutResult.canvasRenderDelta <= 2,
        `Blackout Mode failed to pause live waveform canvas rAF (${blackoutResult.canvasRenderDelta} frames rendered while blacked out)`,
      );
    }

    return { summary, failures };
  } finally {
    if (cpuThrottle > 1) {
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }).catch(() => {});
    }
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
  const server = await startPreviewServer(port);

  const profiles = [
    {
      name: 'mobile-3x-dpr-1x-cpu',
      cpuThrottle: 1,
      measureSeconds: 5,
      checkBlackoutPause: true,
      budgets: {
        minFps: 52,
        maxP95FrameMs: 25,
        maxSevereStalls: 2,
        maxScriptMsPerSec: 120,
        maxRecalcStylePerSec: 25,
        maxLayoutPerSec: 20,
        minWindowChunks: 140,
        maxChunkIntervalMs: 120,
        minRecordedSec: 4.5,
      },
    },
    {
      name: 'mobile-3x-dpr-4x-slow-cpu',
      cpuThrottle: 4,
      measureSeconds: 5,
      checkBlackoutPause: false,
      budgets: {
        minFps: 38,
        maxP95FrameMs: 52,
        maxSevereStalls: 5,
        maxScriptMsPerSec: 260,
        maxRecalcStylePerSec: 25,
        maxLayoutPerSec: 20,
        minWindowChunks: 140,
        maxChunkIntervalMs: 180,
        minRecordedSec: 4.5,
      },
    },
  ];

  let allPassed = true;
  console.log('\nStoryTape Headless Chrome Recording Performance Gate');
  console.log('====================================================');

  try {
    for (const profile of profiles) {
      const { summary, failures } = await runProfile({ baseUrl, wavPath, profile });
      const status = failures.length === 0 ? 'PASS' : 'FAIL';
      console.log(
        `\n[${status}] ${summary.name} (${summary.cpuThrottle}x CPU, 3x DPR)` +
          `\n  FPS: ${summary.fps} | p50=${summary.p50FrameMs}ms p95=${summary.p95FrameMs}ms max=${summary.maxFrameMs}ms | stalls(>50ms)=${summary.severeStalls}` +
          `\n  Main thread: script=${summary.scriptMsPerSec}ms/s task=${summary.taskMsPerSec}ms/s | recalcStyle=${summary.recalcStylePerSec}/s layout=${summary.layoutPerSec}/s` +
          `\n  Audio: worklet=${summary.workletLoaded} scriptProc=${summary.scriptProcessorCreated} keepalivePlays=${summary.loopingAudioPlayCalls} chunks=${summary.windowChunks} (mean=${summary.meanChunkIntervalMs}ms max=${summary.maxChunkIntervalMs}ms)` +
          `\n  Canvas & PCM: canvas=${summary.canvasPixelWidth}px/${summary.canvasClientWidth}css | recorded=${summary.recordedDurationSec}s zeroRuns=${summary.zeroRuns} maxAbs=${summary.maxAbs}` +
          (summary.blackoutResult
            ? `\n  Blackout pause: canvasRenders=${summary.blackoutResult.canvasRenderDelta} audioChunks=${summary.blackoutResult.chunkDelta}`
            : ''),
      );
      if (failures.length > 0) {
        allPassed = false;
        for (const f of failures) {
          console.error(`  ✗ ${f}`);
        }
      }
    }
  } finally {
    server.kill('SIGTERM');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log('');
  if (!allPassed) {
    console.error('Headless Chrome performance gate FAILED.');
    process.exit(1);
  }
  console.log('Headless Chrome performance gate PASSED.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
