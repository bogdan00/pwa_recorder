import { describe, expect, it } from 'vitest';
import {
  buildScorecardRows,
  evaluateProfileResults,
  formatScorecardMarkdown,
  formatScorecardText,
  PERF_PROFILES,
} from '../../scripts/perfBudgets.mjs';

const HEALTHY_FAST = {
  name: 'mobile-3x-dpr-1x-cpu',
  cpuThrottle: 1,
  fps: 60.0,
  p50FrameMs: 16.7,
  p95FrameMs: 16.8,
  maxFrameMs: 16.9,
  severeStalls: 0,
  scriptMsPerSec: 28.0,
  taskMsPerSec: 185.0,
  recalcStylePerSec: 10.0,
  layoutPerSec: 10.2,
  workletLoaded: 1,
  scriptProcessorCreated: 0,
  loopingAudioPlayCalls: 0,
  windowChunks: 200,
  meanChunkIntervalMs: 25.0,
  maxChunkIntervalMs: 48.0,
  canvasPixelWidth: 712,
  canvasClientWidth: 356,
  recordedDurationSec: 6.1,
  zeroRuns: 0,
  maxAbs: 0.23,
  blackoutResult: { canvasRenderDelta: 0, chunkDelta: 33 },
};

const HEALTHY_SLOW = {
  ...HEALTHY_FAST,
  name: 'mobile-3x-dpr-4x-slow-cpu',
  cpuThrottle: 4,
  fps: 51.8,
  p95FrameMs: 33.3,
  maxFrameMs: 50.1,
  severeStalls: 1,
  scriptMsPerSec: 110.6,
  taskMsPerSec: 910.0,
  maxChunkIntervalMs: 62.0,
  blackoutResult: null,
};

describe('Headless Chrome performance gate budgets & regression detection', () => {
  it('passes cleanly on healthy post-fix 1x and 4x recording profiles', () => {
    expect(evaluateProfileResults(HEALTHY_FAST, PERF_PROFILES[0].budgets)).toEqual([]);
    expect(evaluateProfileResults(HEALTHY_SLOW, PERF_PROFILES[1].budgets)).toEqual([]);
  });

  it('catches the exact pre-fix jank & choppy-capture regressions', () => {
    // 1. Pre-fix 4x CPU jank (27.7-41.2 fps, 66.7ms p95, 18 stalls, 213ms worklet gap)
    const preFixSlow = {
      ...HEALTHY_SLOW,
      fps: 34.0,
      p95FrameMs: 66.7,
      severeStalls: 14,
      recalcStylePerSec: 58.0,
      playbackLatencyHintCalls: 1,
      loopingAudioPlayCalls: 1,
      playheadStallFrames: 12,
      playheadJumpFrames: 4,
      canvasPixelWidth: 1068, // uncapped 3x DPR
      maxChunkIntervalMs: 212.9,
      zeroRuns: 2,
    };
    const failures = evaluateProfileResults(preFixSlow, PERF_PROFILES[1].budgets, {
      maxZeroRun: 480,
    });
    expect(failures.some((f) => /FPS/.test(f))).toBe(true);
    expect(failures.some((f) => /p95 frame time/.test(f))).toBe(true);
    expect(failures.some((f) => /Severe frame stalls/.test(f))).toBe(true);
    expect(failures.some((f) => /RecalcStyle/.test(f))).toBe(true);
    expect(failures.some((f) => /interactive/.test(f))).toBe(true);
    expect(failures.some((f) => /keepalive/.test(f))).toBe(true);
    expect(failures.some((f) => /playhead froze/.test(f))).toBe(true);
    expect(failures.some((f) => /playhead jumped/.test(f))).toBe(true);
    expect(failures.some((f) => /Canvas DPR/.test(f))).toBe(true);
    expect(failures.some((f) => /Max worklet chunk gap/.test(f))).toBe(true);
    expect(failures.some((f) => /silent PCM dropout/.test(f))).toBe(true);
  });

  it('catches ScriptProcessorNode fallback, Blackout rAF leaks, and external network leaks', () => {
    const broken = {
      ...HEALTHY_FAST,
      workletLoaded: 0,
      scriptProcessorCreated: 1,
      blackoutResult: { canvasRenderDelta: 48, chunkDelta: 30 },
    };
    const failures = evaluateProfileResults(broken, PERF_PROFILES[0].budgets, {
      unexpectedExternalUrls: ['GET https://evil.example/tracker.js'],
    });
    expect(failures.some((f) => /AudioWorklet/.test(f))).toBe(true);
    expect(failures.some((f) => /Blackout Mode failed to pause/.test(f))).toBe(true);
    expect(failures.some((f) => /Unexpected external requests/.test(f))).toBe(true);
  });

  it('renders a complete Pre-Submit Scorecard in both terminal text and GitHub Actions Markdown', () => {
    const canary = {
      passed: true,
      caughtCount: 2,
      recalcStylePerSec: 60.2,
      loopingAudioPlayCalls: 1,
    };
    const rows = buildScorecardRows(HEALTHY_FAST, HEALTHY_SLOW, canary);
    expect(rows.length).toBe(13);
    expect(rows.every((r) => r.ok)).toBe(true);

    const text = formatScorecardText(rows);
    expect(text).toContain('StoryTape Pre-Submit Performance & Audio-Integrity Scorecard');
    expect(text).toContain('Freeze-Free & Jump-Free Playhead PLL');
    expect(text).toContain('Low-Latency Interactive AudioWorklet');
    expect(text).toContain('Live Regression-Detection Canary');
    expect(text).toContain('caught 2/2 injected bugs');

    const md = formatScorecardMarkdown(rows);
    expect(md).toContain('| Guard / Benefit | Measured | Budget | Status |');
    expect(md).toContain('Opt-In iOS Audio Keepalive (OFF default)');
  });
});
