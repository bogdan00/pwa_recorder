/**
 * Tier 1 Formal Verification: PCM Audio Timeline Exhaustive Algebraic Proofs
 *
 * Runs on every `npm test` (~<1s, zero WASM overhead) directly against real `PcmTimeline`.
 * Verifies:
 *   1. Exact Frame Conservation across arbitrary multi-chunk layouts (mono & stereo)
 *   2. 1-Step Truncate → Undo Bit-for-Bit Left-Inverse (channels + peaks + duration)
 *   3. Storage-Block Round-Trip Conservation (`loadFromChunks(buildStorageBlocks(...))`)
 *   4. Raised-Cosine Anti-Click Continuity: zero amplitude at tail cut edge & gain ∈ [0, 1]
 *   5. IEEE-754 Closed-Interval Bounds & Monotonicity for `msToFrame` and `extractChannelData`
 */

import { describe, expect, it } from 'vitest';
import { PcmTimeline } from '../../audio/pcmTimeline';
import { forAll, forAllPairs } from '../core/algebra';
import {
  generateCanonicalPcmCases,
  specClampFrame,
  specExpectedExtractionLength,
  specExpectedFadeFrames,
  specRaisedCosineGain,
  type PcmTestCase,
} from '../specs/pcmTimelineSpec';

function buildDeterministicTimeline(tc: PcmTestCase): {
  timeline: PcmTimeline;
  expectedFrames: number;
} {
  const timeline = new PcmTimeline(tc.sampleRate, tc.channels);
  let frameOffset = 0;
  for (const frameCount of tc.chunkFrameCounts) {
    const interleaved = new Float32Array(frameCount * tc.channels);
    for (let f = 0; f < frameCount; f += 1) {
      const globalFrame = frameOffset + f;
      for (let ch = 0; ch < tc.channels; ch += 1) {
        // Non-zero deterministic signal in [-0.9, 0.9] distinct per frame & channel
        const phase = (globalFrame + 1) * 0.13 + ch * 0.7;
        interleaved[f * tc.channels + ch] = Math.fround(0.2 + 0.6 * Math.sin(phase));
      }
    }
    timeline.appendFrames(interleaved);
    frameOffset += frameCount;
  }
  return { timeline, expectedFrames: frameOffset };
}

function channelArraysBitEqual(a: Float32Array[], b: Float32Array[]): boolean {
  if (a.length !== b.length) return false;
  for (let ch = 0; ch < a.length; ch += 1) {
    if (a[ch].length !== b[ch].length) return false;
    for (let i = 0; i < a[ch].length; i += 1) {
      if (a[ch][i] !== b[ch][i]) return false;
    }
  }
  return true;
}

describe('Tier 1 Formal Proofs: PCM Audio Timeline Algebraic Invariants', () => {
  it('exhaustively proves frame conservation, truncate/undo bit-exact invertibility, and storage-block round-trip', () => {
    const cases = generateCanonicalPcmCases();
    expect(cases.length).toBe(480);

    const cert = forAll(
      'PcmTimeline: Conservation + Truncate/Undo Invertibility + Storage-Block Round-Trip + Anti-Click Tail',
      cases,
      (tc) => {
        const { timeline, expectedFrames } = buildDeterministicTimeline(tc);

        // 1. Frame conservation
        if (timeline.getTotalFrames() !== expectedFrames) return false;

        const beforeData = timeline.extractChannelData();
        const beforePeaks = timeline.getPeaks().slice();

        // 2. Storage-block round-trip conservation
        const blocks = timeline.buildStorageBlocks(tc.blockSeconds);
        const reloaded = new PcmTimeline(tc.sampleRate, tc.channels);
        reloaded.loadFromChunks(blocks);
        if (reloaded.getTotalFrames() !== expectedFrames) return false;
        if (!channelArraysBitEqual(beforeData, reloaded.extractChannelData())) {
          return false;
        }

        // 3. Truncate obeys exact frame clamping
        const clampedCut = specClampFrame(tc.cutFrame, expectedFrames);
        const trimRes = timeline.truncateAtFrame(tc.cutFrame);
        if (timeline.getTotalFrames() !== clampedCut) return false;
        if (!timeline.canUndoTruncate()) return false;
        if (trimRes.trimmedMs < 0) return false;

        // 4. Anti-click boundary invariant: when remaining frames > 0, very last sample is strictly 0
        if (clampedCut > 0) {
          const tail = timeline.extractChannelData(clampedCut - 1, clampedCut);
          for (let ch = 0; ch < tc.channels; ch += 1) {
            if (Math.abs(tail[ch][0]) !== 0) return false;
          }
        }

        // 5. 1-step Undo is a bit-for-bit left-inverse of truncateAtFrame
        if (!timeline.undoTruncate()) return false;
        if (timeline.canUndoTruncate()) return false;
        if (timeline.getTotalFrames() !== expectedFrames) return false;
        if (!channelArraysBitEqual(beforeData, timeline.extractChannelData())) {
          return false;
        }
        const restoredPeaks = timeline.getPeaks();
        if (restoredPeaks.length !== beforePeaks.length) return false;
        for (let i = 0; i < beforePeaks.length; i += 1) {
          if (restoredPeaks[i] !== beforePeaks[i]) return false;
        }

        return true;
      },
    );

    expect(cert.casesChecked).toBe(480);
  });

  it('proves raised-cosine anti-click fade envelope bounds [0, 1] and monotonicity on pause/resume splice', () => {
    const sampleRate = 4000;
    const timeline = new PcmTimeline(sampleRate, 1);
    const constantUnity = new Float32Array(400).fill(1.0); // 100ms constant DC = +1.0
    timeline.appendFrames(constantUnity);

    // Pause boundary applies 15ms raised-cosine tail fade-out (idempotent on repeated calls)
    timeline.markPauseBoundary();
    const afterFirstPause = timeline.extractChannelData()[0].slice();
    timeline.markPauseBoundary();
    const afterSecondPause = timeline.extractChannelData()[0];
    expect(afterSecondPause).toEqual(afterFirstPause); // Idempotence of markPauseBoundary!

    const fadeFrames = specExpectedFadeFrames(400, sampleRate); // 60 frames
    expect(fadeFrames).toBe(60);

    // Last sample must be strictly 0 (zero click discontinuity)
    expect(afterFirstPause[399]).toBe(0);
    // Tail samples must be monotonically decreasing toward 0 and bounded in [0, 1]
    for (let i = 0; i < fadeFrames; i += 1) {
      const idx = 399 - i;
      const expectedGain = Math.fround(specRaisedCosineGain(i / fadeFrames));
      expect(afterFirstPause[idx]).toBeCloseTo(expectedGain, 5);
      expect(afterFirstPause[idx]).toBeGreaterThanOrEqual(0);
      expect(afterFirstPause[idx]).toBeLessThanOrEqual(1);
      if (i > 0) {
        expect(afterFirstPause[idx]).toBeGreaterThanOrEqual(afterFirstPause[idx + 1]);
      }
    }

    // Resumed audio receives 15ms raised-cosine fade-in monotonically increasing from ~0 to 1
    timeline.appendFrames(new Float32Array(200).fill(1.0));
    const resumedSlice = timeline.extractChannelData(400, 400 + fadeFrames)[0];
    for (let f = 0; f < fadeFrames; f += 1) {
      const expectedGain = Math.fround(specRaisedCosineGain((f + 1) / fadeFrames));
      expect(resumedSlice[f]).toBeCloseTo(expectedGain, 5);
      expect(resumedSlice[f]).toBeGreaterThanOrEqual(0);
      expect(resumedSlice[f]).toBeLessThanOrEqual(1);
      if (f > 0) {
        expect(resumedSlice[f]).toBeGreaterThanOrEqual(resumedSlice[f - 1]);
      }
    }
    expect(resumedSlice[fadeFrames - 1]).toBeCloseTo(1, 5);
  });

  it('proves msToFrame closed-interval bounds, monotonicity, and extractChannelData exact lengths across IEEE-754 extremes', () => {
    const timeline = new PcmTimeline(1000, 2);
    timeline.appendFrames(new Float32Array(200).fill(0.25)); // 100 stereo frames = 100ms

    const finiteTimes = [-1000, -1, -0, 0, 0.4, 1, 25, 50.5, 99.9, 100, 101, 10_000];
    const allTimes = [...finiteTimes, Number.NaN, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY];

    // Closed-interval bounds for ALL IEEE-754 inputs
    const boundsCert = forAll('msToFrame ∈ [0, totalFrames]', allTimes, (ms) => {
      const frame = timeline.msToFrame(ms);
      return Number.isInteger(frame) && frame >= 0 && frame <= 100;
    });
    expect(boundsCert.casesChecked).toBe(allTimes.length);

    // Monotonicity on ordered finite numbers
    const monoCert = forAllPairs(
      'ms1 <= ms2 => msToFrame(ms1) <= msToFrame(ms2)',
      finiteTimes,
      finiteTimes,
      (ms1, ms2) => ms1 > ms2 || timeline.msToFrame(ms1) <= timeline.msToFrame(ms2),
    );
    expect(monoCert.casesChecked).toBe(finiteTimes.length * finiteTimes.length);

    // Exact extraction window length across all (start, end) pairs including extremes
    const framePoints = [-50, 0, 1, 50, 100, 200, Number.NaN, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY];
    const extractCert = forAllPairs(
      'extractChannelData(start, end) exact length',
      framePoints,
      framePoints,
      (start, end) => {
        const channels = timeline.extractChannelData(start, end);
        const expectedLen = specExpectedExtractionLength(start, end, 100);
        return (
          channels.length === 2 &&
          channels[0].length === expectedLen &&
          channels[1].length === expectedLen
        );
      },
    );
    expect(extractCert.casesChecked).toBe(framePoints.length * framePoints.length);
  });

  it('proves loadFromChunks reconciles stale or truncated persisted peaks after a crash', () => {
    const timeline = new PcmTimeline(1000, 1);
    const pcm = new Float32Array(1000).fill(0.75); // 1000 frames => 50 expected peaks
    // Simulate a crash where savedPeaks only captured 3 peaks while 1000 frames were persisted
    timeline.loadFromChunks([pcm], [0.1, 0.2, 0.3]);

    expect(timeline.getTotalFrames()).toBe(1000);
    expect(timeline.getPeaks()).toHaveLength(50);
    expect(timeline.getPeaks().every((p) => Math.abs(p - 0.75) < 1e-5)).toBe(true);
  });
});
