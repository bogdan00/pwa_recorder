import { describe, expect, it } from 'vitest';
import {
  aggregateOverallQualityStatus,
  joinQualitySeverity,
  MAX_GLITCH_LOG_ENTRIES,
  RecordingQualityAnalyzer,
  type QualityHeuristicCode,
} from '../recordingQualityAnalyzer';

function generateBroadbandSpeech(
  sampleRate: number,
  durationSec: number,
  opts: {
    rmsScale?: number;
    highBandScale?: number;
    noiseAmp?: number;
    humAmp?: number;
    dcOffset?: number;
  } = {},
): Float32Array {
  const n = Math.round(sampleRate * durationSec);
  const out = new Float32Array(n);
  const rmsScale = opts.rmsScale ?? 1.0;
  const highBandScale = opts.highBandScale ?? 1.0;
  const noiseAmp = opts.noiseAmp ?? 0.0005;
  const humAmp = opts.humAmp ?? 0;
  const dcOffset = opts.dcOffset ?? 0;

  // Deterministic LCG PRNG for reproducible test noise
  let seed = 0x12345678;
  const rand = () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return (seed / 0xffffffff) * 2 - 1;
  };

  for (let i = 0; i < n; i += 1) {
    const t = i / sampleRate;
    // Smooth syllabic speech envelope (2 Hz, C1-continuous with no artificial step clicks)
    const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 2.0 * t);
    const active = 0.02 + 0.98 * env * env;
    const lowVoice =
      0.11 * Math.sin(2 * Math.PI * 220 * t) +
      0.09 * Math.sin(2 * Math.PI * 440 * t) +
      0.07 * Math.sin(2 * Math.PI * 660 * t);
    const midVoice =
      0.06 * Math.sin(2 * Math.PI * 1100 * t) +
      0.05 * Math.sin(2 * Math.PI * 1800 * t);
    const highVoice =
      highBandScale *
      (0.035 * Math.sin(2 * Math.PI * 3200 * t) +
        0.025 * Math.sin(2 * Math.PI * 4800 * t) +
        0.015 * Math.sin(2 * Math.PI * 6200 * t));
    const hum = humAmp * Math.sin(2 * Math.PI * 60 * t);
    out[i] =
      dcOffset +
      hum +
      noiseAmp * rand() +
      rmsScale * active * (lowVoice + midVoice + highVoice);
  }
  return out;
}

function feedInChunks(
  analyzer: RecordingQualityAnalyzer,
  pcm: Float32Array,
  sampleRate: number,
  channels: 1 | 2 = 1,
  meta?: { compressorReductionDb?: number; timestampGapsDelta?: number },
) {
  const chunkFrames = Math.round(sampleRate * 0.5);
  const stride = chunkFrames * channels;
  for (let offset = 0; offset < pcm.length; offset += stride) {
    const slice = pcm.subarray(offset, Math.min(pcm.length, offset + stride));
    analyzer.ingest(slice, offset === 0 ? meta : undefined);
  }
}

function getCheck(analyzer: RecordingQualityAnalyzer, code: QualityHeuristicCode) {
  const report = analyzer.getReport();
  const found = report.checks.find((c) => c.code === code);
  if (!found) throw new Error(`Missing check ${code}`);
  return found;
}

describe('RecordingQualityAnalyzer (10-heuristic off-main-thread DSP suite)', () => {
  const SR = 48000;

  it('reports Good on clean broadband narrated speech and pure 440 Hz calibration tone without false alarms', () => {
    // 1. Clean broadband speech
    const speechAnalyzer = new RecordingQualityAnalyzer(SR, 1);
    const speech = generateBroadbandSpeech(SR, 5.0);
    feedInChunks(speechAnalyzer, speech, SR, 1);
    const speechReport = speechAnalyzer.getReport();
    expect(speechReport.status).toBe('good');
    expect(speechReport.checks).toHaveLength(10);
    for (const c of speechReport.checks) {
      expect(c.severity).toBe('good');
    }

    // 2. Pure 440 Hz sine (like Chromium fake-device capture in E2E / perf gate) must NOT false-trigger muffled_bandwidth
    const sineAnalyzer = new RecordingQualityAnalyzer(SR, 1);
    const sine = new Float32Array(SR * 4);
    for (let i = 0; i < sine.length; i += 1) {
      sine[i] = 0.2 * Math.sin((2 * Math.PI * 440 * i) / SR);
    }
    feedInChunks(sineAnalyzer, sine, SR, 1);
    const sineReport = sineAnalyzer.getReport();
    expect(sineReport.status).toBe('good');
    expect(getCheck(sineAnalyzer, 'muffled_bandwidth').severity).toBe('good');
  });

  it('detects #1 clipping / limiter overdrive', () => {
    const analyzer = new RecordingQualityAnalyzer(SR, 1);
    const hot = new Float32Array(SR * 3);
    for (let i = 0; i < hot.length; i += 1) {
      // Flat-topped hard clipping at 0.99
      hot[i] = Math.max(-0.99, Math.min(0.99, 3.0 * Math.sin((2 * Math.PI * 440 * i) / SR)));
    }
    feedInChunks(analyzer, hot, SR, 1, { compressorReductionDb: -10 });
    expect(getCheck(analyzer, 'clipping').severity).toBe('critical');
    expect(analyzer.getReport().status).toBe('critical');
  });

  it('detects #2 digital clicks / phase-jump discontinuities (Android 480-sample overflow signature)', () => {
    const analyzer = new RecordingQualityAnalyzer(SR, 1);
    const pcm = generateBroadbandSpeech(SR, 4.0);
    // Inject sharp step-discontinuity clicks every 0.4s
    for (let k = 1; k <= 8; k += 1) {
      const idx = Math.floor(k * 0.4 * SR);
      pcm[idx] = pcm[idx - 1] + 0.55;
      pcm[idx + 1] = pcm[idx] - 0.5;
    }
    feedInChunks(analyzer, pcm, SR, 1);
    const check = getCheck(analyzer, 'clicks');
    expect(['warn', 'critical']).toContain(check.severity);
    expect(analyzer.getReport().metrics.totalClicks).toBeGreaterThanOrEqual(2);
  });

  it('detects #3 buffer dropouts / OS timestamp gaps (Android 480-sample zero-fill signature)', () => {
    const analyzer = new RecordingQualityAnalyzer(SR, 1);
    const pcm = generateBroadbandSpeech(SR, 4.0);
    // Zero-fill 480-sample (10 ms) runs inside active speech
    for (let k = 1; k <= 4; k += 1) {
      const start = Math.floor(k * 0.8 * SR);
      pcm.fill(0, start, start + 480);
    }
    feedInChunks(analyzer, pcm, SR, 1, { timestampGapsDelta: 2 });
    const check = getCheck(analyzer, 'dropouts');
    expect(['warn', 'critical']).toContain(check.severity);
    expect(analyzer.getReport().metrics.totalTimestampGaps).toBe(2);
  });

  it('detects #4 dead / muted microphone input (warn >= 6s, critical >= 12s)', () => {
    const analyzer = new RecordingQualityAnalyzer(SR, 1);
    const dead = new Float32Array(SR * 12.5); // exact zeros past 12s critical threshold
    feedInChunks(analyzer, dead, SR, 1);
    expect(getCheck(analyzer, 'dead_input').severity).toBe('critical');
    expect(analyzer.getReport().status).toBe('critical');
  });

  it('detects #5 too-quiet voice level', () => {
    const analyzer = new RecordingQualityAnalyzer(SR, 1);
    const whisper = generateBroadbandSpeech(SR, 5.0, { rmsScale: 0.08, noiseAmp: 0.00005 });
    feedInChunks(analyzer, whisper, SR, 1);
    const check = getCheck(analyzer, 'too_quiet');
    expect(['warn', 'critical']).toContain(check.severity);
  });

  it('detects #6 high background noise / poor SNR', () => {
    const analyzer = new RecordingQualityAnalyzer(SR, 1);
    const noisy = generateBroadbandSpeech(SR, 5.0, { rmsScale: 0.6, noiseAmp: 0.06 });
    feedInChunks(analyzer, noisy, SR, 1);
    const check = getCheck(analyzer, 'high_noise');
    expect(['warn', 'critical']).toContain(check.severity);
  });

  it('detects #7 muffled / telephone-band speech (Bluetooth HFP / blocked mic)', () => {
    const analyzer = new RecordingQualityAnalyzer(SR, 1);
    // Keep 200-2400 Hz speech strong, wipe out 3-8 kHz crispness
    const muffled = generateBroadbandSpeech(SR, 5.0, { highBandScale: 0.001, noiseAmp: 0.00005 });
    feedInChunks(analyzer, muffled, SR, 1);
    const check = getCheck(analyzer, 'muffled_bandwidth');
    expect(['warn', 'critical']).toContain(check.severity);
  });

  it('detects #8 50/60 Hz AC hum & low-frequency rumble', () => {
    const analyzer = new RecordingQualityAnalyzer(SR, 1);
    const hummy = generateBroadbandSpeech(SR, 4.0, { rmsScale: 0.4, humAmp: 0.12 });
    feedInChunks(analyzer, hummy, SR, 1);
    const check = getCheck(analyzer, 'hum_rumble');
    expect(['warn', 'critical']).toContain(check.severity);
  });

  it('detects #9 DC offset bias', () => {
    const analyzer = new RecordingQualityAnalyzer(SR, 1);
    const biased = generateBroadbandSpeech(SR, 3.5, { dcOffset: 0.1 });
    feedInChunks(analyzer, biased, SR, 1);
    expect(getCheck(analyzer, 'dc_offset').severity).toBe('critical');
  });

  it('detects #10 stereo dead-channel anomaly (L active, R silent)', () => {
    const analyzer = new RecordingQualityAnalyzer(SR, 2);
    const mono = generateBroadbandSpeech(SR, 6.5);
    const stereo = new Float32Array(mono.length * 2);
    for (let i = 0; i < mono.length; i += 1) {
      stereo[i * 2] = mono[i];
      stereo[i * 2 + 1] = 0; // Right channel dead!
    }
    feedInChunks(analyzer, stereo, SR, 2);
    expect(getCheck(analyzer, 'channel_anomaly').severity).toBe('warn');
  });

  it('enforces bounded glitch log length (<= MAX_GLITCH_LOG_ENTRIES) and critical non-masking during warm-up', () => {
    expect(joinQualitySeverity('good', 'warn')).toBe('warn');
    expect(joinQualitySeverity('warn', 'critical')).toBe('critical');
    expect(
      aggregateOverallQualityStatus([{ severity: 'good' }, { severity: 'critical' }], false),
    ).toBe('critical');
    expect(
      aggregateOverallQualityStatus([{ severity: 'good' }, { severity: 'warn' }], false),
    ).toBe('listening');

    const analyzer = new RecordingQualityAnalyzer(SR, 1);
    // Feed 50 separate timestamp-gap bursts to try to overflow glitchEvents
    const chunk = generateBroadbandSpeech(SR, 0.5);
    for (let i = 0; i < 50; i += 1) {
      analyzer.ingest(chunk, { timestampGapsDelta: 1 });
    }
    const report = analyzer.getReport();
    expect(report.glitchEvents.length).toBeLessThanOrEqual(MAX_GLITCH_LOG_ENTRIES);
  });
});
