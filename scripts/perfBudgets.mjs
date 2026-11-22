/**
 * Pure performance & audio-integrity budget definitions, evaluator, and scorecard
 * formatters shared by `scripts/perfCheck.mjs` and `src/__tests__/perfCheck.test.ts`.
 */

export const PERF_PROFILES = [
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
      maxPlayheadStallFrames: 0,
      maxPlayheadJumpFrames: 0,
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
      maxPlayheadStallFrames: 2,
      maxPlayheadJumpFrames: 0,
    },
  },
];

/**
 * Evaluates a measured headless-Chrome recording profile against its non-regression
 * budgets and returns an array of human-readable failure strings (empty = PASS).
 */
export function evaluateProfileResults(summary, budgets, meta = {}) {
  const {
    pageErrors = [],
    consoleErrors = [],
    unexpectedExternalUrls = [],
    workletErrors = [],
    maxZeroRun = 0,
  } = meta;

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
  const hasModernCapture =
    (summary.trackProcessorCreated ?? 0) >= 1 || summary.workletLoaded === 1;
  check(
    hasModernCapture &&
      summary.scriptProcessorCreated === 0 &&
      workletErrors.length === 0,
    `Expected MediaStreamTrackProcessor or off-main-thread AudioWorklet (trackProcessor=${summary.trackProcessorCreated ?? 0}, worklet=${summary.workletLoaded}, scriptProcessor=${summary.scriptProcessorCreated}, errors=${JSON.stringify(workletErrors)})`,
  );
  check(
    (summary.playbackLatencyHintCalls ?? 0) === 0,
    `Live capture AudioContext must use low-latency 'interactive' mode (got ${summary.playbackLatencyHintCalls} 'playback' latencyHint calls)`,
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
  if (typeof budgets.maxPlayheadStallFrames === 'number') {
    const stalls = summary.playheadStallFrames ?? 0;
    check(
      stalls <= budgets.maxPlayheadStallFrames,
      `Waveform playhead froze for ${stalls} frame(s), exceeding budget <= ${budgets.maxPlayheadStallFrames}`,
    );
  }
  if (typeof budgets.maxPlayheadJumpFrames === 'number') {
    const jumps = summary.playheadJumpFrames ?? 0;
    check(
      jumps <= budgets.maxPlayheadJumpFrames,
      `Waveform playhead jumped on ${jumps} frame(s), exceeding budget <= ${budgets.maxPlayheadJumpFrames}`,
    );
  }
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
    `Capture chunks received (${summary.windowChunks}) fell below >= ${budgets.minWindowChunks}`,
  );
  check(
    summary.meanChunkIntervalMs >= 18 && summary.meanChunkIntervalMs <= 35,
    `Mean capture chunk interval ${summary.meanChunkIntervalMs}ms outside healthy [18, 35]ms range`,
  );
  check(
    summary.maxChunkIntervalMs <= budgets.maxChunkIntervalMs,
    `Max capture chunk gap ${summary.maxChunkIntervalMs}ms exceeded budget <= ${budgets.maxChunkIntervalMs}ms`,
  );
  check(
    summary.recordedDurationSec >= budgets.minRecordedSec,
    `Persisted PCM duration ${summary.recordedDurationSec}s fell below >= ${budgets.minRecordedSec}s`,
  );
  check(
    summary.zeroRuns === 0,
    `Detected ${summary.zeroRuns} silent PCM dropout run(s) >= 32 samples (maxZeroRun=${maxZeroRun})`,
  );
  check(
    (summary.stepClicks ?? 0) === 0,
    `Detected ${summary.stepClicks ?? 0} phase/step-discontinuity click(s) in captured sine PCM`,
  );
  check(
    summary.maxAbs >= 0.05,
    `Captured PCM amplitude too low (maxAbs=${summary.maxAbs}); expected live sine audio`,
  );

  if (summary.blackoutResult) {
    check(
      summary.blackoutResult.chunkDelta >= 15,
      `Blackout Mode interrupted audio capture (only ${summary.blackoutResult.chunkDelta} chunks in 0.8s)`,
    );
    check(
      summary.blackoutResult.canvasRenderDelta <= 2,
      `Blackout Mode failed to pause live waveform canvas rAF (${summary.blackoutResult.canvasRenderDelta} frames rendered while blacked out)`,
    );
  }

  return failures;
}

/**
 * Builds structured rows for the Pre-Submit Performance & Audio-Integrity Scorecard
 * showing every guarded benefit, measured result, budget, and pass/fail status.
 */
export function buildScorecardRows(fast, slow, canary) {
  const fastBudgets = PERF_PROFILES[0].budgets;
  const slowBudgets = PERF_PROFILES[1].budgets;
  const effectiveDpr =
    fast.canvasClientWidth > 0
      ? (fast.canvasPixelWidth / fast.canvasClientWidth).toFixed(1)
      : '0.0';

  const rows = [
    {
      guard: 'Smooth 60fps Canvas (1x CPU @ 3x DPR)',
      measured: `${fast.fps} fps (p95 ${fast.p95FrameMs}ms)`,
      budget: `>= ${fastBudgets.minFps} fps / <= ${fastBudgets.maxP95FrameMs}ms`,
      ok:
        fast.fps >= fastBudgets.minFps &&
        fast.p95FrameMs <= fastBudgets.maxP95FrameMs &&
        fast.severeStalls <= fastBudgets.maxSevereStalls,
    },
    {
      guard: 'Slow-Phone Resilience (4x single-vCPU)',
      measured: `${slow.fps} fps (p95 ${slow.p95FrameMs}ms)`,
      budget: `>= ${slowBudgets.minFps} fps / <= ${slowBudgets.maxP95FrameMs}ms`,
      ok:
        slow.fps >= slowBudgets.minFps &&
        slow.p95FrameMs <= slowBudgets.maxP95FrameMs &&
        slow.severeStalls <= slowBudgets.maxSevereStalls,
    },
    {
      guard: 'Freeze-Free & Jump-Free Playhead PLL',
      measured: `stalls ${fast.playheadStallFrames ?? 0}/${slow.playheadStallFrames ?? 0}, jumps ${(fast.playheadJumpFrames ?? 0) + (slow.playheadJumpFrames ?? 0)}`,
      budget: `<= ${fastBudgets.maxPlayheadStallFrames}/${slowBudgets.maxPlayheadStallFrames} stalls, 0 jumps`,
      ok:
        (fast.playheadStallFrames ?? 0) <= fastBudgets.maxPlayheadStallFrames &&
        (slow.playheadStallFrames ?? 0) <= slowBudgets.maxPlayheadStallFrames &&
        (fast.playheadJumpFrames ?? 0) === 0 &&
        (slow.playheadJumpFrames ?? 0) === 0,
    },
    {
      guard: 'Zero 60Hz CSS RecalcStyle Thrashing',
      measured: `${fast.recalcStylePerSec}/s (4x: ${slow.recalcStylePerSec}/s)`,
      budget: `<= ${fastBudgets.maxRecalcStylePerSec}/s`,
      ok:
        fast.recalcStylePerSec <= fastBudgets.maxRecalcStylePerSec &&
        slow.recalcStylePerSec <= slowBudgets.maxRecalcStylePerSec,
    },
    {
      guard: 'Zero Steady-State DOM Layout Thrash',
      measured: `${fast.layoutPerSec}/s (4x: ${slow.layoutPerSec}/s)`,
      budget: `<= ${fastBudgets.maxLayoutPerSec}/s`,
      ok:
        fast.layoutPerSec <= fastBudgets.maxLayoutPerSec &&
        slow.layoutPerSec <= slowBudgets.maxLayoutPerSec,
    },
    {
      guard: 'Main-Thread Script CPU Headroom',
      measured: `${fast.scriptMsPerSec}ms/s (4x: ${slow.scriptMsPerSec}ms/s)`,
      budget: `<= ${fastBudgets.maxScriptMsPerSec} / ${slowBudgets.maxScriptMsPerSec}ms/s`,
      ok:
        fast.scriptMsPerSec <= fastBudgets.maxScriptMsPerSec &&
        slow.scriptMsPerSec <= slowBudgets.maxScriptMsPerSec,
    },
    {
      guard: 'Retina DPR<=2 Cap on 3x Phones (-56% px)',
      measured: `${fast.canvasPixelWidth}px/${fast.canvasClientWidth}css (${effectiveDpr}x)`,
      budget: '<= 2.0x DPR',
      ok:
        fast.canvasClientWidth > 0 &&
        fast.canvasPixelWidth <= Math.ceil(fast.canvasClientWidth * 2) + 2,
    },
    {
      guard: 'Opt-In iOS Audio Keepalive (OFF default)',
      measured: `${fast.loopingAudioPlayCalls + slow.loopingAudioPlayCalls} looping plays`,
      budget: '0 plays',
      ok: fast.loopingAudioPlayCalls === 0 && slow.loopingAudioPlayCalls === 0,
    },
    {
      guard: 'Direct TrackProcessor / Interactive Capture',
      measured: `tp=${fast.trackProcessorCreated ?? 0}, worklet=${fast.workletLoaded}, playbackHint=${(fast.playbackLatencyHintCalls ?? 0) + (slow.playbackLatencyHintCalls ?? 0)}`,
      budget: 'tp>=1 or wk=1, pbHint=0',
      ok:
        ((fast.trackProcessorCreated ?? 0) >= 1 || fast.workletLoaded === 1) &&
        fast.scriptProcessorCreated === 0 &&
        ((slow.trackProcessorCreated ?? 0) >= 1 || slow.workletLoaded === 1) &&
        slow.scriptProcessorCreated === 0 &&
        (fast.playbackLatencyHintCalls ?? 0) === 0 &&
        (slow.playbackLatencyHintCalls ?? 0) === 0,
    },
    {
      guard: 'Capture Chunk Cadence & Max Gap',
      measured: `mean ${fast.meanChunkIntervalMs}ms, max ${fast.maxChunkIntervalMs}/${slow.maxChunkIntervalMs}ms`,
      budget: `<= ${fastBudgets.maxChunkIntervalMs}/${slowBudgets.maxChunkIntervalMs}ms`,
      ok:
        fast.maxChunkIntervalMs <= fastBudgets.maxChunkIntervalMs &&
        slow.maxChunkIntervalMs <= slowBudgets.maxChunkIntervalMs,
    },
    {
      guard: 'Glitch-Free Persisted PCM (0 Drops/Clicks)',
      measured: `${fast.zeroRuns + slow.zeroRuns} drops, ${(fast.stepClicks ?? 0) + (slow.stepClicks ?? 0)} clicks (${fast.recordedDurationSec}s)`,
      budget: '0 drops, 0 clicks',
      ok:
        fast.zeroRuns === 0 &&
        slow.zeroRuns === 0 &&
        (fast.stepClicks ?? 0) === 0 &&
        (slow.stepClicks ?? 0) === 0,
    },
  ];

  if (fast.blackoutResult) {
    rows.push({
      guard: 'OLED Blackout Mode Pauses Canvas rAF',
      measured: `${fast.blackoutResult.canvasRenderDelta} renders, ${fast.blackoutResult.chunkDelta} audio ch`,
      budget: '<= 2 renders, >= 15 ch',
      ok:
        fast.blackoutResult.canvasRenderDelta <= 2 &&
        fast.blackoutResult.chunkDelta >= 15,
    });
  }

  if (canary) {
    rows.push({
      guard: 'Live Regression-Detection Canary',
      measured: `caught ${canary.caughtCount}/2 injected bugs (${canary.recalcStylePerSec}/s, ${canary.loopingAudioPlayCalls} play)`,
      budget: 'catches RecalcStyle + keepalive',
      ok: canary.passed,
    });
  }

  return rows;
}

export function formatScorecardText(rows) {
  const col1 = Math.max(40, ...rows.map((r) => r.guard.length));
  const col2 = Math.max(24, ...rows.map((r) => r.measured.length));
  const col3 = Math.max(22, ...rows.map((r) => r.budget.length));
  const pad = (s, w) => s + ' '.repeat(Math.max(0, w - s.length));
  const sep = '='.repeat(col1 + col2 + col3 + 14);
  const dash = '-'.repeat(col1 + col2 + col3 + 14);

  const lines = [
    '',
    sep,
    '  StoryTape Pre-Submit Performance & Audio-Integrity Scorecard',
    sep,
    `  ${pad('Guard / Benefit', col1)}  ${pad('Measured', col2)}  ${pad('Budget', col3)}  Status`,
    `  ${dash.slice(2)}`,
    ...rows.map(
      (r) =>
        `  ${pad(r.guard, col1)}  ${pad(r.measured, col2)}  ${pad(r.budget, col3)}  ${r.ok ? 'PASS' : 'FAIL'}`,
    ),
    sep,
  ];
  return lines.join('\n');
}

export function formatScorecardMarkdown(rows) {
  const lines = [
    '### StoryTape Headless Chrome Performance & Audio-Integrity Scorecard',
    '',
    '| Guard / Benefit | Measured | Budget | Status |',
    '| --- | --- | --- | --- |',
    ...rows.map(
      (r) =>
        `| ${r.guard} | \`${r.measured}\` | \`${r.budget}\` | ${r.ok ? 'PASS' : 'FAIL'} |`,
    ),
    '',
  ];
  return lines.join('\n');
}
