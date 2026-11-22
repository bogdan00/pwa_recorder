import type { ChannelCountOption } from '../types/models';
import type { RecordingQualitySummary } from './recordingPerfTelemetry';

export type QualitySeverity = 'good' | 'warn' | 'critical';
export type QualityStatus = 'listening' | QualitySeverity;

export type QualityHeuristicCode =
  | 'clipping'
  | 'clicks'
  | 'dropouts'
  | 'dead_input'
  | 'too_quiet'
  | 'high_noise'
  | 'muffled_bandwidth'
  | 'hum_rumble'
  | 'dc_offset'
  | 'channel_anomaly';

export interface QualityHeuristicCheck {
  code: QualityHeuristicCode;
  label: string;
  shortBadge: string;
  severity: QualitySeverity;
  detail: string;
  tip: string;
}

export interface QualityGlitchEvent {
  timeSec: number;
  code: QualityHeuristicCode;
  message: string;
}

export interface RecordingQualityMetrics {
  analyzedSec: number;
  speechSec: number;
  speechRmsDb: number | null;
  noiseFloorDb: number | null;
  snrDb: number | null;
  peakDb: number | null;
  clarityTiltDb: number | null;
  dcOffset: number;
  totalClicks: number;
  totalDropouts: number;
  totalTimestampGaps: number;
  saturatedFrameRatio: number;
}

export interface RecordingQualityReport {
  status: QualityStatus;
  shortLabel: string;
  headline: string;
  primaryIssueCode: QualityHeuristicCode | null;
  primaryTip: string | null;
  checks: QualityHeuristicCheck[];
  metrics: RecordingQualityMetrics;
  glitchEvents: QualityGlitchEvent[];
  updatedAt: number;
}

export interface QualityIngestMeta {
  compressorReductionDb?: number;
  timestampGapsDelta?: number;
}

export const MAX_GLITCH_LOG_ENTRIES = 30;
const FFT_SIZE = 1024;
const WARMUP_ANALYZED_SEC = 2.0;

// Precomputed radix-2 FFT tables (1024-pt Hann window + twiddle factors)
const HANN_WINDOW = new Float32Array(FFT_SIZE);
const BIT_REV = new Uint16Array(FFT_SIZE);
const COS_TABLE = new Float32Array(FFT_SIZE / 2);
const SIN_TABLE = new Float32Array(FFT_SIZE / 2);

(() => {
  const bits = Math.round(Math.log2(FFT_SIZE));
  for (let i = 0; i < FFT_SIZE; i += 1) {
    HANN_WINDOW[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)));
    let rev = 0;
    let x = i;
    for (let b = 0; b < bits; b += 1) {
      rev = (rev << 1) | (x & 1);
      x >>= 1;
    }
    BIT_REV[i] = rev;
  }
  for (let i = 0; i < FFT_SIZE / 2; i += 1) {
    const angle = (-2 * Math.PI * i) / FFT_SIZE;
    COS_TABLE[i] = Math.cos(angle);
    SIN_TABLE[i] = Math.sin(angle);
  }
})();

export function severityRank(s: QualitySeverity): 0 | 1 | 2 {
  if (s === 'critical') return 2;
  if (s === 'warn') return 1;
  return 0;
}

/**
 * Join-Semilattice operator over `QualitySeverity` (`good < warn < critical`).
 * Idempotent, commutative, and associative.
 */
export function joinQualitySeverity(
  a: QualitySeverity,
  b: QualitySeverity,
): QualitySeverity {
  return severityRank(a) >= severityRank(b) ? a : b;
}

/**
 * Aggregates heuristic check severities into overall `QualityStatus`.
 * Invariant: warm-up (`!isWarmedUp`) NEVER masks an active `'critical'` fault.
 */
export function aggregateOverallQualityStatus(
  checks: ReadonlyArray<{ severity: QualitySeverity }>,
  isWarmedUp: boolean,
): QualityStatus {
  let maxSev: QualitySeverity = 'good';
  for (let i = 0; i < checks.length; i += 1) {
    maxSev = joinQualitySeverity(maxSev, checks[i].severity);
  }
  if (maxSev === 'critical') return 'critical';
  if (!isWarmedUp) return 'listening';
  return maxSev;
}

function clampDb(linear: number, floorDb = -90): number {
  if (!Number.isFinite(linear) || linear <= 1e-9) return floorDb;
  const db = 20 * Math.log10(linear);
  if (!Number.isFinite(db)) return floorDb;
  return Math.max(floorDb, Math.min(0, Math.round(db * 10) / 10));
}

function finiteOrNull(val: number | null): number | null {
  if (val === null || !Number.isFinite(val)) return null;
  return Math.round(val * 10) / 10;
}

interface Frame10MsSummary {
  timeSec: number;
  rms: number;
  peak: number;
  saturated: boolean;
  clipped: boolean;
  isSpeech: boolean;
  isDeadSilence: boolean;
  dcMean: number;
  ch0Rms: number;
  ch1Rms: number;
  lrCorr: number;
}

/**
 * Pure-TypeScript streaming 10-heuristic recording quality analyzer.
 * Designed to run inside `qualityMonitor.worker.ts` (Dedicated Web Worker)
 * with zero DOM dependencies and deterministic unit-testability.
 */
export class RecordingQualityAnalyzer {
  private sampleRate = 48000;
  private channels: ChannelCountOption = 1;
  private totalFrames = 0;

  // Frame accumulator for exact 10ms analysis windows (480 samples @ 48 kHz)
  private frameSize10Ms = 480;
  private pendingMono = new Float32Array(480);
  private pendingCh1 = new Float32Array(480);
  private pendingOffset = 0;
  private prevSample = 0;
  private prevDiffAvg = 0.005;
  private lastClickFrameIndex = -100000;
  private zeroRunCount = 0;
  private zeroRunTriggered = false;
  private recentActiveBeforeZero = false;

  // Rolling 10ms frame history (~15 seconds = 1500 frames)
  private readonly maxHistoryFrames = 1500;
  private frameHistory: Frame10MsSummary[] = [];

  // Rolling click & dropout timestamps (seconds)
  private clickTimesSec: number[] = [];
  private dropoutTimesSec: number[] = [];
  private timestampGapTimesSec: number[] = [];
  private totalClicks = 0;
  private totalDropouts = 0;
  private totalTimestampGaps = 0;

  // Continuous dead-silence & quiet/hum/dc/channel persistence counters (seconds)
  private continuousDeadSilenceSec = 0;
  private continuousDcWarnSec = 0;
  private continuousDcCritSec = 0;
  private continuousStereoFaultSec = 0;
  private halfScalePeakFrames = 0;
  private aboveHalfScaleFrames = 0;
  private speechSecTotal = 0;

  // FFT scratch buffers (reused across calls, zero GC churn)
  private readonly fftBuf = new Float32Array(FFT_SIZE);
  private fftFill = 0;
  private readonly fftRe = new Float32Array(FFT_SIZE);
  private readonly fftIm = new Float32Array(FFT_SIZE);
  private readonly fftMagSq = new Float32Array(FFT_SIZE / 2);

  // Rolling spectral metrics (1024-pt FFT evaluated ~4x/sec)
  private muffledSpeechSec = 0;
  private narrowbandHfpSec = 0;
  private brightSpeechSec = 0;
  private latestClarityTiltDb: number | null = null;
  private humRumbleSec = 0;
  private tonalHumSec = 0;
  private maxPeakSeen = 0;

  // Bounded take-wide glitch timeline
  private glitchEvents: QualityGlitchEvent[] = [];

  constructor(sampleRate = 48000, channels: ChannelCountOption = 1) {
    this.reset(sampleRate, channels);
  }

  reset(sampleRate = 48000, channels: ChannelCountOption = 1): void {
    this.sampleRate = Math.max(8000, Math.round(sampleRate || 48000));
    this.channels = channels === 2 ? 2 : 1;
    this.frameSize10Ms = Math.max(80, Math.round(this.sampleRate * 0.01));
    this.pendingMono = new Float32Array(this.frameSize10Ms);
    this.pendingCh1 = new Float32Array(this.frameSize10Ms);
    this.pendingOffset = 0;
    this.totalFrames = 0;
    this.prevSample = 0;
    this.prevDiffAvg = 0.005;
    this.lastClickFrameIndex = -100000;
    this.zeroRunCount = 0;
    this.zeroRunTriggered = false;
    this.recentActiveBeforeZero = false;
    this.frameHistory = [];
    this.clickTimesSec = [];
    this.dropoutTimesSec = [];
    this.timestampGapTimesSec = [];
    this.totalClicks = 0;
    this.totalDropouts = 0;
    this.totalTimestampGaps = 0;
    this.continuousDeadSilenceSec = 0;
    this.continuousDcWarnSec = 0;
    this.continuousDcCritSec = 0;
    this.continuousStereoFaultSec = 0;
    this.halfScalePeakFrames = 0;
    this.aboveHalfScaleFrames = 0;
    this.speechSecTotal = 0;
    this.fftFill = 0;
    this.muffledSpeechSec = 0;
    this.narrowbandHfpSec = 0;
    this.brightSpeechSec = 0;
    this.latestClarityTiltDb = null;
    this.humRumbleSec = 0;
    this.tonalHumSec = 0;
    this.maxPeakSeen = 0;
    this.glitchEvents = [];
  }

  private pushGlitchEvent(
    timeSec: number,
    code: QualityHeuristicCode,
    message: string,
  ): void {
    const roundedTime = Math.round(Math.max(0, timeSec) * 10) / 10;
    // Deduplicate identical code within 1.0s to prevent flooding the 30-item log
    const last = this.glitchEvents[this.glitchEvents.length - 1];
    if (last && last.code === code && Math.abs(roundedTime - last.timeSec) < 1.0) {
      return;
    }
    this.glitchEvents.push({ timeSec: roundedTime, code, message });
    if (this.glitchEvents.length > MAX_GLITCH_LOG_ENTRIES) {
      this.glitchEvents.splice(
        0,
        this.glitchEvents.length - MAX_GLITCH_LOG_ENTRIES,
      );
    }
  }

  ingest(interleaved: Float32Array, meta?: QualityIngestMeta): void {
    const ch = this.channels;
    const frames = Math.floor(interleaved.length / ch);
    if (frames <= 0) return;

    const compReductionDb =
      meta && Number.isFinite(meta.compressorReductionDb)
        ? (meta.compressorReductionDb as number)
        : 0;
    const tsGaps =
      meta &&
      typeof meta.timestampGapsDelta === 'number' &&
      meta.timestampGapsDelta > 0
        ? Math.floor(meta.timestampGapsDelta)
        : 0;

    if (tsGaps > 0) {
      const nowSec = this.totalFrames / this.sampleRate;
      this.totalTimestampGaps += tsGaps;
      for (let g = 0; g < tsGaps; g += 1) {
        this.timestampGapTimesSec.push(nowSec);
      }
      this.pushGlitchEvent(
        nowSec,
        'clicks',
        `Mic stream gap (${tsGaps} dropped frame${tsGaps > 1 ? 's' : ''})`,
      );
    }

    const minClickSpacingSamples = Math.round(this.sampleRate * 0.02);

    for (let f = 0; f < frames; f += 1) {
      const raw0 = interleaved[f * ch];
      const s0 = Number.isFinite(raw0) ? raw0 : 0;
      const raw1 = ch === 2 ? interleaved[f * ch + 1] : s0;
      const s1 = Number.isFinite(raw1) ? raw1 : 0;
      const abs0 = Math.abs(s0);
      if (abs0 > this.maxPeakSeen) this.maxPeakSeen = abs0;

      // 1. Sample-level step-discontinuity click detector (catches 480-sample FIFO phase jumps!)
      const globalSampleIdx = this.totalFrames;
      const diff = Math.abs(s0 - this.prevSample);
      if (
        globalSampleIdx > 64 &&
        diff > 0.045 &&
        diff > this.prevDiffAvg * 8 &&
        globalSampleIdx - this.lastClickFrameIndex > minClickSpacingSamples
      ) {
        const tSec = globalSampleIdx / this.sampleRate;
        this.lastClickFrameIndex = globalSampleIdx;
        this.totalClicks += 1;
        this.clickTimesSec.push(tSec);
        this.pushGlitchEvent(tSec, 'clicks', 'Audio click / phase jump');
      }
      // Smooth local derivative baseline (excluding the spike itself)
      const clampedDiff = Math.min(diff, this.prevDiffAvg * 3 + 0.01);
      this.prevDiffAvg = this.prevDiffAvg * 0.94 + clampedDiff * 0.06;
      this.prevSample = s0;

      // 2. Sample-level micro-dropout detector (>= 64 exact/near zeros during active speech)
      if (abs0 < 0.0005) {
        this.zeroRunCount += 1;
        if (
          this.zeroRunCount === 64 &&
          this.recentActiveBeforeZero &&
          !this.zeroRunTriggered
        ) {
          this.zeroRunTriggered = true;
        }
      } else {
        if (
          this.zeroRunTriggered &&
          this.zeroRunCount <= this.sampleRate * 0.15 &&
          abs0 > 0.015
        ) {
          const tSec = (globalSampleIdx - this.zeroRunCount) / this.sampleRate;
          this.totalDropouts += 1;
          this.dropoutTimesSec.push(tSec);
          this.pushGlitchEvent(tSec, 'dropouts', 'Micro-dropout during speech');
        }
        this.zeroRunCount = 0;
        this.zeroRunTriggered = false;
        if (abs0 > 0.025) {
          this.recentActiveBeforeZero = true;
        }
      }

      // Accumulate into 10ms analysis frame
      this.pendingMono[this.pendingOffset] = s0;
      if (ch === 2) {
        this.pendingCh1[this.pendingOffset] = s1;
      }
      this.pendingOffset += 1;
      this.totalFrames += 1;

      if (this.pendingOffset >= this.frameSize10Ms) {
        this.analyze10MsFrame(compReductionDb);
        this.pendingOffset = 0;
      }

      // Accumulate into 1024-pt FFT buffer (step every ~250ms = 4x/sec)
      if (this.fftFill < FFT_SIZE) {
        this.fftBuf[this.fftFill] = s0;
        this.fftFill += 1;
        if (this.fftFill === FFT_SIZE) {
          this.analyzeFftFrame();
          // Skip next ~10,000 samples (~210 ms) by setting negative countdown
          this.fftFill = -Math.max(0, Math.round(this.sampleRate * 0.21));
        }
      } else {
        this.fftFill += 1;
      }
    }

    // Prune rolling 15s event timestamp queues
    const cutoffSec = this.totalFrames / this.sampleRate - 15;
    while (this.clickTimesSec.length > 0 && this.clickTimesSec[0] < cutoffSec) {
      this.clickTimesSec.shift();
    }
    while (
      this.dropoutTimesSec.length > 0 &&
      this.dropoutTimesSec[0] < cutoffSec
    ) {
      this.dropoutTimesSec.shift();
    }
    while (
      this.timestampGapTimesSec.length > 0 &&
      this.timestampGapTimesSec[0] < cutoffSec
    ) {
      this.timestampGapTimesSec.shift();
    }
  }

  private analyze10MsFrame(compReductionDb: number): void {
    const n = this.frameSize10Ms;
    const ch0 = this.pendingMono;
    const ch1 = this.pendingCh1;
    const isStereo = this.channels === 2;
    const timeSec = this.totalFrames / this.sampleRate;

    let sumSq0 = 0;
    let sumSq1 = 0;
    let dot01 = 0;
    let sum0 = 0;
    let peak = 0;
    let clipRun = 0;
    let hardClipped = false;

    for (let i = 0; i < n; i += 1) {
      const s0 = ch0[i];
      const a0 = Math.abs(s0);
      sum0 += s0;
      sumSq0 += s0 * s0;
      if (a0 > peak) peak = a0;

      if (a0 >= 0.96 || (a0 >= 0.87 && a0 <= 0.9)) {
        clipRun += 1;
        if (clipRun >= 3) hardClipped = true;
      } else {
        clipRun = 0;
      }

      if (isStereo) {
        const s1 = ch1[i];
        const a1 = Math.abs(s1);
        sumSq1 += s1 * s1;
        dot01 += s0 * s1;
        if (a1 > peak) peak = a1;
      }
    }

    const rms0 = Math.sqrt(sumSq0 / n);
    const rms1 = isStereo ? Math.sqrt(sumSq1 / n) : rms0;
    const rms = isStereo ? Math.max(rms0, rms1) : rms0;
    const dcMean = sum0 / n;
    const lrCorr =
      isStereo && sumSq0 > 1e-8 && sumSq1 > 1e-8
        ? dot01 / Math.sqrt(sumSq0 * sumSq1)
        : 1;

    const isDeadSilence = rms < 0.00056; // < -65 dBFS
    const isSpeech = rms >= 0.0025; // >= -52 dBFS (captures whispers down to -52 dBFS for too_quiet detection)
    const saturated =
      hardClipped || peak >= 0.707 || compReductionDb <= -6.0;

    if (isDeadSilence) {
      this.continuousDeadSilenceSec += 0.01;
      this.recentActiveBeforeZero = false;
    } else {
      this.continuousDeadSilenceSec = 0;
    }

    if (isSpeech) {
      this.speechSecTotal += 0.01;
      if (!isStereo) {
        if (peak >= 0.42 && peak <= 0.46) {
          this.halfScalePeakFrames += 1;
        } else if (peak > 0.48) {
          this.aboveHalfScaleFrames += 1;
        }
      }
    }

    if (hardClipped) {
      this.pushGlitchEvent(timeSec, 'clipping', 'Hard clipping / ceiling slam');
    }

    // DC offset persistence
    const absDc = Math.abs(dcMean);
    if (absDc > 0.08) {
      this.continuousDcCritSec += 0.01;
      this.continuousDcWarnSec += 0.01;
    } else if (absDc > 0.02) {
      this.continuousDcWarnSec += 0.01;
      this.continuousDcCritSec = Math.max(0, this.continuousDcCritSec - 0.02);
    } else {
      this.continuousDcWarnSec = Math.max(0, this.continuousDcWarnSec - 0.03);
      this.continuousDcCritSec = Math.max(0, this.continuousDcCritSec - 0.03);
    }

    // Stereo channel fault persistence (dead channel > 18 dB imbalance OR inverted phase)
    if (isStereo && isSpeech) {
      const louder = Math.max(rms0, rms1, 1e-7);
      const quieter = Math.min(rms0, rms1);
      const imbalanceDb = 20 * Math.log10(louder / Math.max(1e-7, quieter));
      if (imbalanceDb > 18 || lrCorr < -0.5) {
        this.continuousStereoFaultSec += 0.01;
      } else {
        this.continuousStereoFaultSec = Math.max(
          0,
          this.continuousStereoFaultSec - 0.02,
        );
      }
    }

    // Check 10ms HPF-ringing micro-dropout: look back 3 frames (30ms) once we have surrounding context
    const histLen = this.frameHistory.length;
    if (histLen >= 6) {
      const mid = this.frameHistory[histLen - 3];
      if (mid.rms < 0.004) {
        const beforeMax = Math.max(
          this.frameHistory[histLen - 6].rms,
          this.frameHistory[histLen - 5].rms,
          this.frameHistory[histLen - 4].rms,
        );
        const afterMax = Math.max(
          this.frameHistory[histLen - 2].rms,
          this.frameHistory[histLen - 1].rms,
          rms,
        );
        if (beforeMax > 0.02 && afterMax > 0.02) {
          const lastDrop =
            this.dropoutTimesSec[this.dropoutTimesSec.length - 1] ?? -10;
          if (mid.timeSec - lastDrop > 0.05) {
            this.totalDropouts += 1;
            this.dropoutTimesSec.push(mid.timeSec);
            this.pushGlitchEvent(
              mid.timeSec,
              'dropouts',
              '10 ms audio dropout during speech',
            );
          }
        }
      }
    }

    this.frameHistory.push({
      timeSec,
      rms,
      peak,
      saturated,
      clipped: hardClipped,
      isSpeech,
      isDeadSilence,
      dcMean,
      ch0Rms: rms0,
      ch1Rms: rms1,
      lrCorr,
    });
    if (this.frameHistory.length > this.maxHistoryFrames) {
      this.frameHistory.shift();
    }
  }

  private analyzeFftFrame(): void {
    // Compute RMS of this 1024-sample window
    let sumSq = 0;
    for (let i = 0; i < FFT_SIZE; i += 1) {
      const s = this.fftBuf[i];
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / FFT_SIZE);
    if (rms < 0.0005) return; // Silence: skip FFT

    // Apply Hann window + bit-reversal copy
    for (let i = 0; i < FFT_SIZE; i += 1) {
      this.fftRe[BIT_REV[i]] = this.fftBuf[i] * HANN_WINDOW[i];
      this.fftIm[BIT_REV[i]] = 0;
    }

    // Iterative Cooley-Tukey radix-2 FFT
    for (let size = 2; size <= FFT_SIZE; size <<= 1) {
      const half = size >> 1;
      const step = FFT_SIZE / size;
      for (let i = 0; i < FFT_SIZE; i += size) {
        for (let j = 0; j < half; j += 1) {
          const idx = j * step;
          const wr = COS_TABLE[idx];
          const wi = SIN_TABLE[idx];
          const k = i + j + half;
          const tr = wr * this.fftRe[k] - wi * this.fftIm[k];
          const ti = wr * this.fftIm[k] + wi * this.fftRe[k];
          this.fftRe[k] = this.fftRe[i + j] - tr;
          this.fftIm[k] = this.fftIm[i + j] - ti;
          this.fftRe[i + j] += tr;
          this.fftIm[i + j] += ti;
        }
      }
    }

    const binHz = this.sampleRate / FFT_SIZE;
    const halfBins = FFT_SIZE / 2;
    const norm = 1 / (FFT_SIZE * FFT_SIZE * 0.375); // Hann power normalization
    for (let b = 0; b < halfBins; b += 1) {
      this.fftMagSq[b] =
        (this.fftRe[b] * this.fftRe[b] + this.fftIm[b] * this.fftIm[b]) * norm;
    }

    const bandPower = (loHz: number, hiHz: number): number => {
      const b0 = Math.max(1, Math.floor(loHz / binHz));
      const b1 = Math.min(halfBins - 1, Math.ceil(hiHz / binHz));
      let p = 0;
      for (let b = b0; b <= b1; b += 1) p += this.fftMagSq[b];
      return p;
    };

    const pHumRumble = bandPower(45, 130);
    const pLowVoice = bandPower(200, 800);
    const pMidVoice = bandPower(800, 2400);
    const pVoice200_1000 = bandPower(200, 1000);
    const pVoice200_2000 = bandPower(200, 2000);
    const pVoice300_3000 = bandPower(300, 3000);
    const pClarity = bandPower(2500, 7500);
    const pUpper4k8k = bandPower(4000, 8000);

    const frameDt = 0.25; // ~4 FFT evaluations/sec

    // 1. 50/60 Hz tonal mains hum & low-end rumble
    const humRumbleDb = 10 * Math.log10(Math.max(1e-12, pHumRumble));
    const humVsVoiceDb =
      10 * Math.log10(Math.max(1e-12, pHumRumble) / Math.max(1e-12, pVoice200_2000));
    const bin60 = Math.round(60 / binHz);
    const bin50 = Math.round(50 / binHz);
    const peakMains = Math.max(
      this.fftMagSq[bin50] ?? 0,
      this.fftMagSq[bin60] ?? 0,
      this.fftMagSq[Math.min(halfBins - 1, bin60 + 1)] ?? 0,
    );
    const mainsDb = 10 * Math.log10(Math.max(1e-12, peakMains));
    const isPauseLike = rms < 0.025;

    if (isPauseLike && mainsDb > -38 && humVsVoiceDb > 6) {
      this.tonalHumSec += frameDt;
    } else {
      this.tonalHumSec = Math.max(0, this.tonalHumSec - frameDt * 0.5);
    }

    if (rms >= 0.01 && humRumbleDb > -34 && humVsVoiceDb > 4) {
      this.humRumbleSec += frameDt;
    } else {
      this.humRumbleSec = Math.max(0, this.humRumbleSec - frameDt * 0.5);
    }

    // 2. Muffled / Bluetooth HFP narrowband check (only on broadband speech frames,
    //    ignoring single-frequency calibration tones where 800-2400 Hz is absent)
    if (rms >= 0.015 && pVoice200_1000 > 1e-7) {
      const midToLowDb =
        10 *
        Math.log10(
          Math.max(1e-12, pMidVoice) / Math.max(1e-12, pLowVoice),
        );
      const isBroadbandSpeech = midToLowDb > -24;
      if (isBroadbandSpeech) {
        const clarityTiltDb =
          10 *
          Math.log10(
            Math.max(1e-12, pClarity) / Math.max(1e-12, pVoice200_1000),
          );
        const hfpDropDb =
          10 *
          Math.log10(
            Math.max(1e-12, pUpper4k8k) / Math.max(1e-12, pVoice300_3000),
          );
        this.latestClarityTiltDb =
          this.latestClarityTiltDb === null
            ? clarityTiltDb
            : this.latestClarityTiltDb * 0.75 + clarityTiltDb * 0.25;

        if (hfpDropDb < -36) {
          this.narrowbandHfpSec += frameDt;
          this.muffledSpeechSec += frameDt;
        } else if (clarityTiltDb < -28) {
          this.muffledSpeechSec += frameDt;
          this.narrowbandHfpSec = Math.max(
            0,
            this.narrowbandHfpSec - frameDt * 0.5,
          );
        } else {
          this.brightSpeechSec += frameDt;
          this.muffledSpeechSec = Math.max(
            0,
            this.muffledSpeechSec - frameDt * 0.75,
          );
          this.narrowbandHfpSec = Math.max(
            0,
            this.narrowbandHfpSec - frameDt * 0.75,
          );
        }
      }
    }
  }

  getReport(): RecordingQualityReport {
    const analyzedSec = Math.round((this.totalFrames / this.sampleRate) * 10) / 10;
    const isWarmedUp = analyzedSec >= WARMUP_ANALYZED_SEC;
    const hist = this.frameHistory;

    // Rolling 10s speech & saturation metrics + 15s SNR percentiles
    const latestTime = analyzedSec;
    let activeFrames10s = 0;
    let saturatedFrames10s = 0;
    let clippedFrames10s = 0;
    let speechSqSum10s = 0;
    let speechPeak10s = 0;
    let latestDc = 0;

    // Collect 50ms block RMS over rolling 15s for 15th/85th percentile noise floor & SNR
    const block50Rms: number[] = [];
    let blkSq = 0;
    let blkCount = 0;

    for (let i = 0; i < hist.length; i += 1) {
      const f = hist[i];
      blkSq += f.rms * f.rms;
      blkCount += 1;
      if (blkCount === 5) {
        block50Rms.push(Math.sqrt(blkSq / 5));
        blkSq = 0;
        blkCount = 0;
      }

      if (latestTime - f.timeSec <= 10) {
        latestDc = f.dcMean;
        if (f.isSpeech) {
          activeFrames10s += 1;
          speechSqSum10s += f.rms * f.rms;
          if (f.peak > speechPeak10s) speechPeak10s = f.peak;
          if (f.saturated) saturatedFrames10s += 1;
          if (f.clipped) clippedFrames10s += 1;
        }
      }
    }

    let noiseFloorDb: number | null = null;
    let speechRmsDb: number | null = null;
    let snrDb: number | null = null;

    if (activeFrames10s >= 20) {
      const activeRms = Math.sqrt(speechSqSum10s / activeFrames10s);
      speechRmsDb = clampDb(activeRms);
    }

    if (block50Rms.length >= 10) {
      block50Rms.sort((a, b) => a - b);
      const p15 = block50Rms[Math.floor(block50Rms.length * 0.15)];
      const p85 = block50Rms[Math.floor(block50Rms.length * 0.85)];
      // Only compute ambient noise floor when the signal isn't 100% continuous loud tone
      noiseFloorDb = clampDb(p15);
      const p85Db = clampDb(p85);
      if (speechRmsDb !== null && p85 > 0.008) {
        // If there are real pauses (p15 clearly below p85), report empirical SNR
        if (p85Db - noiseFloorDb >= 1) {
          snrDb = Math.max(0, Math.round((p85Db - noiseFloorDb) * 10) / 10);
        }
      }
    }

    const saturatedFrameRatio =
      activeFrames10s > 0
        ? Math.round((saturatedFrames10s / activeFrames10s) * 1000) / 1000
        : 0;
    const recentClicks = this.clickTimesSec.length;
    const recentDropouts = this.dropoutTimesSec.length;
    const recentTsGaps = this.timestampGapTimesSec.length;

    // Evaluate all 10 heuristics
    // 1. Clipping & limiter overdrive
    let clippingSev: QualitySeverity = 'good';
    let clippingDetail = 'Clean headroom, no clipping';
    if (
      clippedFrames10s >= 8 ||
      (activeFrames10s >= 30 && saturatedFrameRatio >= 0.15)
    ) {
      clippingSev = 'critical';
      clippingDetail = `${Math.round(saturatedFrameRatio * 100)}% of speech hitting ceiling`;
    } else if (
      clippedFrames10s >= 3 ||
      (activeFrames10s >= 30 && saturatedFrameRatio >= 0.05)
    ) {
      clippingSev = 'warn';
      clippingDetail = `${Math.round(saturatedFrameRatio * 100)}% of speech near ceiling`;
    }

    // 2. Clicks, pops & dropped frames
    let clicksSev: QualitySeverity = 'good';
    let clicksDetail = 'No clicks or dropped frames';
    if (
      recentClicks >= 5 ||
      recentTsGaps >= 3 ||
      this.totalClicks >= 12
    ) {
      clicksSev = 'critical';
      clicksDetail = `${this.totalClicks} clicks / ${this.totalTimestampGaps} stream gaps`;
    } else if (recentClicks >= 2 || recentTsGaps >= 1) {
      clicksSev = 'warn';
      clicksDetail = `${recentClicks} recent clicks, ${recentTsGaps} stream gaps`;
    }

    // 3. Micro-dropouts
    let dropoutSev: QualitySeverity = 'good';
    let dropoutDetail = 'Continuous audio stream';
    if (recentDropouts >= 3) {
      dropoutSev = 'critical';
      dropoutDetail = `${this.totalDropouts} dropouts during speech`;
    } else if (recentDropouts >= 1) {
      dropoutSev = 'warn';
      dropoutDetail = `${recentDropouts} brief dropout detected`;
    }

    // 4. Dead mic / muted input
    let deadSev: QualitySeverity = 'good';
    let deadDetail = 'Microphone signal active';
    if (this.continuousDeadSilenceSec >= 12) {
      deadSev = 'critical';
      deadDetail = `No audio signal for ${Math.round(this.continuousDeadSilenceSec)}s`;
    } else if (this.continuousDeadSilenceSec >= 6) {
      deadSev = 'warn';
      deadDetail = `Silent input for ${Math.round(this.continuousDeadSilenceSec)}s`;
    }

    // 5. Too quiet
    let quietSev: QualitySeverity = 'good';
    let quietDetail =
      speechRmsDb !== null ? `Speech ${speechRmsDb} dBFS` : 'Waiting for speech';
    if (activeFrames10s >= 40 && speechRmsDb !== null) {
      if (speechRmsDb < -42) {
        quietSev = 'critical';
        quietDetail = `Very quiet speech (${speechRmsDb} dBFS)`;
      } else if (speechRmsDb < -32 && speechPeak10s < 0.125) {
        quietSev = 'warn';
        quietDetail = `Low speech level (${speechRmsDb} dBFS)`;
      }
    }

    // 6. High background noise / low SNR
    let noiseSev: QualitySeverity = 'good';
    let noiseDetail =
      snrDb !== null
        ? `SNR ${snrDb} dB · floor ${noiseFloorDb} dBFS`
        : noiseFloorDb !== null
          ? `Floor ${noiseFloorDb} dBFS`
          : 'Measuring room tone';
    // Avoid flagging constant-amplitude calibration tones with zero dynamic spread as "room noise"
    const hasNoiseSpread =
      noiseFloorDb !== null &&
      (snrDb !== null ||
        (speechRmsDb === null && analyzedSec >= 3 && noiseFloorDb > -40));
    if (hasNoiseSpread && noiseFloorDb !== null) {
      if (
        (snrDb !== null && snrDb < 12 && this.speechSecTotal >= 2) ||
        (snrDb !== null && noiseFloorDb > -30)
      ) {
        noiseSev = 'critical';
        noiseDetail =
          snrDb !== null
            ? `Heavy noise (SNR ${snrDb} dB, floor ${noiseFloorDb} dBFS)`
            : `Loud background floor (${noiseFloorDb} dBFS)`;
      } else if (
        (snrDb !== null && snrDb < 18 && this.speechSecTotal >= 2) ||
        (snrDb !== null && noiseFloorDb > -40)
      ) {
        noiseSev = 'warn';
        noiseDetail =
          snrDb !== null
            ? `Background noise (SNR ${snrDb} dB)`
            : `Elevated room floor (${noiseFloorDb} dBFS)`;
      }
    }

    // 7. Muffled / Bluetooth HFP narrowband bandwidth
    let muffledSev: QualitySeverity = 'good';
    let muffledDetail =
      this.latestClarityTiltDb !== null
        ? `Clarity tilt ${Math.round(this.latestClarityTiltDb)} dB`
        : 'Full voice bandwidth';
    if (this.narrowbandHfpSec >= 6 || this.muffledSpeechSec >= 10) {
      muffledSev = 'critical';
      muffledDetail =
        this.narrowbandHfpSec >= 6
          ? 'Telephone-band cutoff (check Bluetooth/Mic Mode)'
          : `Severely muffled speech (${Math.round(this.latestClarityTiltDb ?? -30)} dB tilt)`;
    } else if (this.narrowbandHfpSec >= 3 || this.muffledSpeechSec >= 5) {
      muffledSev = 'warn';
      muffledDetail =
        this.narrowbandHfpSec >= 3
          ? 'Narrow voice bandwidth detected'
          : `Muffled highs (${Math.round(this.latestClarityTiltDb ?? -29)} dB tilt)`;
    }

    // 8. 50/60 Hz hum & low-end rumble
    let humSev: QualitySeverity = 'good';
    let humDetail = 'Clean low end';
    if (this.tonalHumSec >= 3 || this.humRumbleSec >= 4) {
      humSev = 'warn';
      humDetail =
        this.tonalHumSec >= 3
          ? '50/60 Hz electrical hum detected'
          : 'Excessive low-frequency rumble/wind';
    }

    // 9. DC offset
    let dcSev: QualitySeverity = 'good';
    let dcDetail = 'Zero DC bias';
    if (this.continuousDcCritSec >= 3) {
      dcSev = 'critical';
      dcDetail = `Severe DC offset (${Math.round(latestDc * 1000) / 1000})`;
    } else if (this.continuousDcWarnSec >= 3) {
      dcSev = 'warn';
      dcDetail = `Elevated DC offset (${Math.round(latestDc * 1000) / 1000})`;
    }

    // 10. Channel anomaly (stereo dead side / phase inversion OR mono 0.438 half-scale wall)
    let chanSev: QualitySeverity = 'good';
    let chanDetail =
      this.channels === 2 ? 'Balanced stereo channels' : 'Clean mono channel';
    if (this.channels === 2 && this.continuousStereoFaultSec >= 4) {
      chanSev = 'warn';
      chanDetail = 'Stereo imbalance or inverted phase';
    } else if (
      this.channels === 1 &&
      this.halfScalePeakFrames >= 10 &&
      this.aboveHalfScaleFrames === 0
    ) {
      chanSev = 'warn';
      chanDetail = 'Half-scale ceiling detected (~-6 dBFS wall)';
    }

    const checks: QualityHeuristicCheck[] = [
      {
        code: 'clipping',
        label: 'Clipping & Headroom',
        shortBadge: clippingSev === 'critical' ? 'Audio Clipping' : 'Near Clipping',
        severity: clippingSev,
        detail: clippingDetail,
        tip: 'Back slightly away from the mic or lower Input Gain in Studio Settings.',
      },
      {
        code: 'clicks',
        label: 'Clicks & Frame Continuity',
        shortBadge:
          clicksSev === 'critical'
            ? `Audio Glitches (${this.totalClicks + this.totalTimestampGaps})`
            : `Audio Clicks (${recentClicks + recentTsGaps})`,
        severity: clicksSev,
        detail: clicksDetail,
        tip: 'Close heavy background apps, disable Bluetooth hands-free mic, or keep the screen awake.',
      },
      {
        code: 'dropouts',
        label: 'Dropouts & Gaps',
        shortBadge: `Dropouts (${this.totalDropouts})`,
        severity: dropoutSev,
        detail: dropoutDetail,
        tip: 'Check microphone connection or switch to built-in phone mic if wireless dropouts persist.',
      },
      {
        code: 'dead_input',
        label: 'Microphone Signal',
        shortBadge: 'No Audio Input',
        severity: deadSev,
        detail: deadDetail,
        tip: 'Check mute switches, mic permissions, or choose a different microphone in Studio Settings.',
      },
      {
        code: 'too_quiet',
        label: 'Voice Level',
        shortBadge: 'Too Quiet',
        severity: quietSev,
        detail: quietDetail,
        tip: 'Move closer to the microphone, enable Auto Gain Control, or raise Input Gain in Settings.',
      },
      {
        code: 'high_noise',
        label: 'Background Noise (SNR)',
        shortBadge: noiseSev === 'critical' ? 'Severe Noise' : 'Background Noise',
        severity: noiseSev,
        detail: noiseDetail,
        tip: 'Move away from fans/AC/traffic or turn on Browser Noise Suppression in Settings.',
      },
      {
        code: 'muffled_bandwidth',
        label: 'Voice Clarity & Bandwidth',
        shortBadge:
          this.narrowbandHfpSec >= 3 ? 'Bluetooth Low-Q' : 'Muffled · Check Mic',
        severity: muffledSev,
        detail: muffledDetail,
        tip: 'Uncover the mic port, disconnect Bluetooth HFP headsets, or on iOS set Control Center → Mic Mode → Standard.',
      },
      {
        code: 'hum_rumble',
        label: '50/60 Hz Hum & Rumble',
        shortBadge: 'Hum / Rumble',
        severity: humSev,
        detail: humDetail,
        tip: 'Enable the 80 Hz Rumble Filter, unplug noisy USB chargers, or keep the mic off vibrating surfaces.',
      },
      {
        code: 'dc_offset',
        label: 'DC Offset',
        shortBadge: 'Mic Hardware Bias',
        severity: dcSev,
        detail: dcDetail,
        tip: 'Enable the 80 Hz Rumble Filter or reconnect/replace the USB-C audio adapter.',
      },
      {
        code: 'channel_anomaly',
        label: 'Channel Balance',
        shortBadge: this.channels === 2 ? '1-Channel Stereo' : 'Half-Scale Cap',
        severity: chanSev,
        detail: chanDetail,
        tip:
          this.channels === 2
            ? 'Switch Channels to Mono (1 ch) in Studio Settings when using a single microphone.'
            : 'Check microphone routing and Audio Settings; mono capture appears capped at -6 dBFS.',
      },
    ];

    const overallStatus = aggregateOverallQualityStatus(checks, isWarmedUp);
    const primaryIssue =
      checks.find((c) => c.severity === 'critical') ??
      checks.find((c) => c.severity === 'warn') ??
      null;

    const shortLabel =
      overallStatus === 'listening'
        ? 'Checking audio…'
        : overallStatus === 'good'
          ? 'Audio Good'
          : primaryIssue?.shortBadge ?? 'Check Audio';

    const headline =
      overallStatus === 'listening'
        ? 'Listening to your microphone…'
        : overallStatus === 'good'
          ? 'Recording audio sounds clean'
          : primaryIssue
            ? `${primaryIssue.label}: ${primaryIssue.detail}`
            : 'Check recording setup';

    return {
      status: overallStatus,
      shortLabel,
      headline,
      primaryIssueCode:
        overallStatus === 'warn' || overallStatus === 'critical'
          ? (primaryIssue?.code ?? null)
          : null,
      primaryTip:
        overallStatus === 'warn' || overallStatus === 'critical'
          ? (primaryIssue?.tip ?? null)
          : null,
      checks,
      metrics: {
        analyzedSec,
        speechSec: Math.round(this.speechSecTotal * 10) / 10,
        speechRmsDb: finiteOrNull(speechRmsDb),
        noiseFloorDb: finiteOrNull(noiseFloorDb),
        snrDb: finiteOrNull(snrDb),
        peakDb: this.maxPeakSeen > 0 ? clampDb(this.maxPeakSeen) : null,
        clarityTiltDb: finiteOrNull(this.latestClarityTiltDb),
        dcOffset: Math.round(latestDc * 10000) / 10000,
        totalClicks: this.totalClicks,
        totalDropouts: this.totalDropouts,
        totalTimestampGaps: this.totalTimestampGaps,
        saturatedFrameRatio,
      },
      glitchEvents: this.glitchEvents.slice(),
      updatedAt: Date.now(),
    };
  }

  getSummary(): RecordingQualitySummary {
    const r = this.getReport();
    return {
      overallStatus: r.status,
      analyzedSec: r.metrics.analyzedSec,
      speechSec: r.metrics.speechSec,
      totalClicks: r.metrics.totalClicks,
      totalDropouts: r.metrics.totalDropouts,
      saturatedFrameRatio: r.metrics.saturatedFrameRatio,
      speechRmsDb: r.metrics.speechRmsDb,
      noiseFloorDb: r.metrics.noiseFloorDb,
      snrDb: r.metrics.snrDb,
      clarityTiltDb: r.metrics.clarityTiltDb,
      triggeredCodes: r.checks
        .filter((c) => c.severity !== 'good')
        .map((c) => c.code),
    };
  }
}
