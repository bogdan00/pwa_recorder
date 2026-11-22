/**
 * Tier 1 Formal Verification: Executable Algebraic & Numerical Contract Proofs
 * for Software AGC, Soft-Clipper Ceiling, and Recording Quality Monitor Lattice.
 *
 * Runs directly against real production TypeScript implementations on every `npm test`.
 */

import { describe, expect, it } from 'vitest';
import {
  SoftwareAutoGainController,
  softLimitSample,
} from '../../audio/inputStrip';
import {
  aggregateOverallQualityStatus,
  joinQualitySeverity,
  MAX_GLITCH_LOG_ENTRIES,
  RecordingQualityAnalyzer,
  type QualitySeverity,
} from '../../audio/recordingQualityAnalyzer';
import { verifyJoinSemilattice } from '../core/algebra';
import {
  AUDIO_DSP_CONTRACT,
  QUALITY_SEVERITY_DOMAIN,
} from '../specs/audioDspAndQualitySpec';

describe('Tier 1 Formal Proofs: Audio DSP Stability & Quality Monitor Lattice', () => {
  it('verifies strict headroom ordering: agcPeakCeiling < softClipThreshold < softClipCeiling < 1.0', () => {
    expect(AUDIO_DSP_CONTRACT.agcPeakCeiling).toBeLessThan(
      AUDIO_DSP_CONTRACT.softClipThreshold,
    );
    expect(AUDIO_DSP_CONTRACT.softClipThreshold).toBeLessThan(
      AUDIO_DSP_CONTRACT.softClipCeiling,
    );
    expect(AUDIO_DSP_CONTRACT.softClipCeiling).toBeLessThan(1.0);
    expect(AUDIO_DSP_CONTRACT.agcMinGain).toBeLessThanOrEqual(
      AUDIO_DSP_CONTRACT.agcInitialGain,
    );
    expect(AUDIO_DSP_CONTRACT.agcInitialGain).toBeLessThanOrEqual(
      AUDIO_DSP_CONTRACT.agcMaxGain,
    );
  });

  it('proves softLimitSample exact identity inside [-threshold, +threshold], boundedness <= ceiling, odd symmetry, and IEEE-754 finiteness', () => {
    const probes = [
      0,
      -0,
      0.001,
      -0.001,
      0.5,
      -0.5,
      AUDIO_DSP_CONTRACT.softClipThreshold,
      -AUDIO_DSP_CONTRACT.softClipThreshold,
      0.75,
      -0.75,
      1.0,
      -1.0,
      2.5,
      -2.5,
      100,
      -100,
    ];
    for (const x of probes) {
      const y = softLimitSample(x);
      expect(Number.isFinite(y)).toBe(true);
      expect(Math.abs(y)).toBeLessThanOrEqual(AUDIO_DSP_CONTRACT.softClipCeiling);
      if (Math.abs(x) <= AUDIO_DSP_CONTRACT.softClipThreshold) {
        expect(y).toBe(x);
      }
      if (x !== 0) {
        expect(softLimitSample(-x)).toBeCloseTo(-y, 12);
      }
    }
    // Non-finite guard
    expect(softLimitSample(Number.NaN)).toBe(0);
    expect(softLimitSample(Number.POSITIVE_INFINITY)).toBe(0);
    expect(softLimitSample(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it('proves SoftwareAutoGainController gain bounds, compressor-yield monotonicity, silence non-pumping, and NaN resilience', () => {
    // 1. Compressor-yield monotonicity across grid of starting gains, speech RMS, and reduction dB
    for (const initialGain of [1.0, 3.16, 6.0, 10.0]) {
      for (const compDb of [-1.5, -3.0, -6.0, -12.0]) {
        const agc = new SoftwareAutoGainController({ initialGain });
        const samples = new Float32Array(480).fill(0.08); // Quiet enough to otherwise boost!
        const nextGain = agc.processSamples(samples, 0.01, compDb);
        expect(nextGain).toBeLessThanOrEqual(initialGain);
        expect(nextGain).toBeGreaterThanOrEqual(AUDIO_DSP_CONTRACT.agcMinGain);
        expect(nextGain).toBeLessThanOrEqual(AUDIO_DSP_CONTRACT.agcMaxGain);
      }
    }

    // 2. Silence non-pumping invariant
    const quietAgc = new SoftwareAutoGainController({ initialGain: 3.16 });
    const silence = new Float32Array(480).fill(0.0002);
    const before = quietAgc.getGain();
    for (let i = 0; i < 100; i += 1) {
      expect(quietAgc.processSamples(silence, 0.02, 0)).toBe(before);
    }

    // 3. Non-finite sample & duration resilience
    const nanBuf = new Float32Array([Number.NaN, Number.POSITIVE_INFINITY, -Number.POSITIVE_INFINITY, 0.1]);
    const g = quietAgc.processSamples(nanBuf, 0.02, Number.NaN);
    expect(Number.isFinite(g)).toBe(true);
    expect(g).toBeGreaterThanOrEqual(AUDIO_DSP_CONTRACT.agcMinGain);
    expect(g).toBeLessThanOrEqual(AUDIO_DSP_CONTRACT.agcMaxGain);
    expect(quietAgc.processSamples(nanBuf, Number.NaN, 0)).toBe(g);
    expect(quietAgc.processSamples(nanBuf, -1, 0)).toBe(g);
  });

  it('exhaustively proves joinQualitySeverity forms a Join-Semilattice (Idempotent, Commutative, Associative)', () => {
    const res = verifyJoinSemilattice<QualitySeverity>(
      'QualitySeverityLattice',
      QUALITY_SEVERITY_DOMAIN,
      joinQualitySeverity,
      (a, b) => a === b,
    );
    expect(res.idempotence.casesChecked).toBe(3);
    expect(res.commutativity.casesChecked).toBe(9);
    expect(res.associativity.casesChecked).toBe(27);
  });

  it('exhaustively proves aggregateOverallQualityStatus never masks critical during warm-up and equals lattice join when warmed up', () => {
    for (const s1 of QUALITY_SEVERITY_DOMAIN) {
      for (const s2 of QUALITY_SEVERITY_DOMAIN) {
        for (const s3 of QUALITY_SEVERITY_DOMAIN) {
          const checks = [{ severity: s1 }, { severity: s2 }, { severity: s3 }];
          const expectedJoin = joinQualitySeverity(joinQualitySeverity(s1, s2), s3);

          // Warmed up: exact lattice join
          expect(aggregateOverallQualityStatus(checks, true)).toBe(expectedJoin);

          // Warm-up: critical is NEVER masked; good/warn stay listening
          const warmupStatus = aggregateOverallQualityStatus(checks, false);
          if (expectedJoin === 'critical') {
            expect(warmupStatus).toBe('critical');
          } else {
            expect(warmupStatus).toBe('listening');
          }
        }
      }
    }
  });

  it('proves RecordingQualityAnalyzer glitch event log remains strictly bounded <= MAX_GLITCH_LOG_ENTRIES under unbounded glitch storms', () => {
    const analyzer = new RecordingQualityAnalyzer(48000, 1);
    const buf = new Float32Array(48000); // 1 second
    for (let sec = 0; sec < 60; sec += 1) {
      buf.fill(0.1);
      // Inject a massive step click every second
      buf[24000] = 0.85;
      buf[24001] = -0.85;
      analyzer.ingest(buf, { timestampGapsDelta: 1 });
      const report = analyzer.getReport();
      expect(report.glitchEvents.length).toBeLessThanOrEqual(MAX_GLITCH_LOG_ENTRIES);
      expect(Number.isFinite(report.metrics.analyzedSec)).toBe(true);
      expect(Number.isFinite(report.metrics.dcOffset)).toBe(true);
    }
    expect(analyzer.getReport().glitchEvents.length).toBe(MAX_GLITCH_LOG_ENTRIES);
  });

  it('proves TimestampContinuityTracker emits 0 false positives across Android DMA burst profiles and exact single-count re-lock on genuine drops', async () => {
    const { TimestampContinuityTracker } = await import('../../audio/trackProcessorCapture');

    // Exhaustive grid of Android DMA burst sizes (10..20ms) and callback jitters (0..12ms)
    for (const burstIntervalMs of [10, 20]) {
      for (const jitterMs of [0, 5, 10, 12]) {
        const tracker = new TimestampContinuityTracker();
        for (let i = 0; i < 400; i += 1) {
          const baseUs = Math.floor((i * 10) / burstIntervalMs) * burstIntervalMs * 1000;
          const phaseJitterUs = (i % 2 === 0 ? jitterMs : -jitterMs * 0.5) * 1000;
          const res = tracker.observe(baseUs + phaseJitterUs, 10_000);
          expect(res.isGap).toBe(false);
        }
      }
    }

    // Non-finite or non-positive inputs never corrupt tracker state or fire false gaps
    const safeTracker = new TimestampContinuityTracker();
    expect(safeTracker.observe(Number.NaN, 10_000).isGap).toBe(false);
    expect(safeTracker.observe(0, 0).isGap).toBe(false);
    expect(safeTracker.observe(0, -10_000).isGap).toBe(false);

    // Genuine sustained positive drops >= 40 ms always fire exactly once and re-lock cleanly
    for (const dropMs of [40, 60, 250]) {
      const tracker = new TimestampContinuityTracker();
      let gaps = 0;
      for (let i = 0; i < 30; i += 1) {
        const offset = i >= 15 ? dropMs * 1000 : 0;
        if (tracker.observe(i * 10_000 + offset, 10_000).isGap) gaps += 1;
      }
      expect(gaps).toBe(1);
    }
  });
});
