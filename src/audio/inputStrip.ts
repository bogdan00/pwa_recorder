import type { AudioQualitySettings } from '../types/models';

/**
 * -3.0 dBFS knee start: normal speech below this level passes at exact 1:1 unity gain
 * with zero harmonic coloration.
 */
export const SOFT_CLIP_THRESHOLD = 0.7071;

/**
 * -1.0 dBFS ceiling: leaves 1.0 dB of true-peak headroom so resampling and lossy
 * AAC/Opus inter-sample peaks never exceed 0 dBFS.
 */
export const SOFT_CLIP_CEILING = 0.8913;

/**
 * Inaudible ultrasonic Nyquist keepalive amplitude (-100 dBFS, well below 16-bit DAC LSB).
 * Alternating +/- at sampleRate/2 keeps Chromium's hardware audio output sink active past
 * the 30-second SilentSinkSuspender timeout with zero DC offset and zero audible sound.
 */
export const KEEPALIVE_AMPLITUDE = 1e-5;

/**
 * C1-continuous soft-clipping transfer function:
 * - Exact identity (y = x) for |x| <= threshold
 * - Smooth tanh knee approaching `ceiling` for |x| > threshold
 * Matches both value and first derivative (dy/dx = 1) at |x| = threshold.
 */
export function softLimitSample(
  x: number,
  threshold = SOFT_CLIP_THRESHOLD,
  ceiling = SOFT_CLIP_CEILING,
): number {
  const abs = Math.abs(x);
  if (abs <= threshold) return x;
  const headroom = Math.max(1e-6, ceiling - threshold);
  const limited = threshold + headroom * Math.tanh((abs - threshold) / headroom);
  return x < 0 ? -limited : limited;
}

let cachedSoftClipCurve: Float32Array<ArrayBuffer> | null = null;

/**
 * Builds an odd-length symmetric WaveShaperNode lookup curve over [-1, 1]
 * using `softLimitSample`. Inputs > 1.0 clamp to the curve endpoint (< -1.0 dBFS).
 */
export function buildSoftClipCurve(
  samples = 8193,
  threshold = SOFT_CLIP_THRESHOLD,
  ceiling = SOFT_CLIP_CEILING,
): Float32Array<ArrayBuffer> {
  const isDefault =
    samples === 8193 &&
    threshold === SOFT_CLIP_THRESHOLD &&
    ceiling === SOFT_CLIP_CEILING;
  if (isDefault && cachedSoftClipCurve) {
    return cachedSoftClipCurve;
  }

  const count = samples % 2 === 1 ? samples : samples + 1;
  const curve = new Float32Array(new ArrayBuffer(count * 4));
  const mid = (count - 1) / 2;
  for (let i = 0; i < count; i += 1) {
    const x = (i - mid) / mid; // -1 .. +1, exact 0 at mid
    curve[i] = softLimitSample(x, threshold, ceiling);
  }

  if (isDefault) {
    cachedSoftClipCurve = curve;
  }
  return curve;
}

/**
 * Transparent post-resample true-peak safety ceiling for compressed encoders and
 * integer PCM WAV output. Returns the original arrays untouched (zero-copy) when
 * all samples already sit below `threshold`.
 */
export function applyPeakCeilingToChannels(
  channels: Float32Array[],
  threshold = 0.85,
  ceiling = SOFT_CLIP_CEILING,
): Float32Array[] {
  let peak = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i += 1) {
      const a = Math.abs(ch[i]);
      if (a > peak) peak = a;
    }
  }
  if (peak <= threshold) {
    return channels;
  }

  return channels.map((ch) => {
    const out = new Float32Array(ch.length);
    for (let i = 0; i < ch.length; i += 1) {
      out[i] = softLimitSample(ch[i], threshold, ceiling);
    }
    return out;
  });
}

/**
 * Writes an alternating +/- KEEPALIVE_AMPLITUDE Nyquist tone into `output`
 * (used by ScriptProcessorNode fallback to mirror pcm-capture-worklet.js).
 */
export function writeNyquistKeepalive(
  output: Float32Array,
  startSign: 1 | -1 = 1,
): 1 | -1 {
  let sign: 1 | -1 = startSign;
  for (let i = 0; i < output.length; i += 1) {
    output[i] = sign * KEEPALIVE_AMPLITUDE;
    sign = sign === 1 ? -1 : 1;
  }
  return sign;
}

export const MIN_INPUT_GAIN_DB = -6;
export const MAX_INPUT_GAIN_DB = 24;

/**
 * Software Auto-Gain Control (AGC) parameters for browsers like iOS/macOS Safari (WebKit)
 * that ignore getUserMedia `autoGainControl` and deliver raw MEMS capsule levels
 * (~-45 to -30 dBFS on normal speech) when `echoCancellation` is disabled.
 */
export const SOFTWARE_AGC_INITIAL_GAIN = 4.0; // +12.0 dB starting boost so syllable #1 is clearly audible
export const SOFTWARE_AGC_MIN_GAIN = 0.5; // -6.0 dB floor to tame unexpectedly hot inputs
export const SOFTWARE_AGC_MAX_GAIN = 16.0; // +24.0 dB ceiling for quiet raw iPhone / dynamic mics
export const SOFTWARE_AGC_TARGET_RMS = 0.125; // ~-18 dBFS audiobook narration RMS target
export const SOFTWARE_AGC_PEAK_CEILING = 0.72; // ~-2.8 dBFS fast-attack peak guard
export const SOFTWARE_AGC_MIN_SPEECH_RMS = 0.0015; // ~-56.5 dBFS pre-AGC floor below which gain holds

/**
 * Converts a linear gain multiplier into decibels clamped to [MIN_INPUT_GAIN_DB, MAX_INPUT_GAIN_DB],
 * snapped to 0.5 dB steps for the Studio Settings slider.
 */
export function gainMultiplierToDb(multiplier: number): number {
  if (!Number.isFinite(multiplier) || multiplier <= 0) {
    return MIN_INPUT_GAIN_DB;
  }
  const db = 20 * Math.log10(multiplier);
  const clamped = Math.max(MIN_INPUT_GAIN_DB, Math.min(MAX_INPUT_GAIN_DB, db));
  const snapped = Math.round(clamped * 2) / 2;
  return Object.is(snapped, -0) ? 0 : snapped;
}

/**
 * Converts a decibel gain value back to a linear multiplier (exact 1.0 at 0 dB).
 */
export function gainDbToMultiplier(db: number): number {
  if (!Number.isFinite(db)) return 1.0;
  const clamped = Math.max(MIN_INPUT_GAIN_DB, Math.min(MAX_INPUT_GAIN_DB, db));
  if (Math.abs(clamped) < 0.01) return 1.0;
  return Number(Math.pow(10, clamped / 20).toFixed(4));
}

export interface SoftwareAutoGainOptions {
  initialGain?: number;
  minGain?: number;
  maxGain?: number;
  targetRms?: number;
  peakCeiling?: number;
  minSpeechRms?: number;
}

/**
 * Speech-gated studio Auto-Gain Controller (AGC) used when the user enables Auto Gain Control
 * on a browser/OS (such as Safari/iOS WebKit with echoCancellation=false) that does not
 * provide native `autoGainControl` on the MediaStreamTrack.
 *
 * - Starts at +12 dB (scaled down if user already boosted manual inputGain) so opening syllables
 *   are immediately audible rather than fading up from silence.
 * - Adapts smoothly upward (~450 ms) toward -18 dBFS RMS during active speech above an adaptive
 *   room-noise floor, holding gain flat during silence so room hiss never pumps between sentences.
 * - Responds rapidly (~75 ms) to pull gain back when loud speech or peaks exceed -2.8 dBFS.
 */
export class SoftwareAutoGainController {
  private currentGain: number;
  private noiseFloorRms: number;
  private readonly minGain: number;
  private readonly maxGain: number;
  private readonly targetRms: number;
  private readonly peakCeiling: number;
  private readonly minSpeechRms: number;

  constructor(options?: SoftwareAutoGainOptions) {
    this.minGain = options?.minGain ?? SOFTWARE_AGC_MIN_GAIN;
    this.maxGain = options?.maxGain ?? SOFTWARE_AGC_MAX_GAIN;
    this.targetRms = options?.targetRms ?? SOFTWARE_AGC_TARGET_RMS;
    this.peakCeiling = options?.peakCeiling ?? SOFTWARE_AGC_PEAK_CEILING;
    this.minSpeechRms = options?.minSpeechRms ?? SOFTWARE_AGC_MIN_SPEECH_RMS;
    this.currentGain = this.clampGain(
      options?.initialGain ?? SOFTWARE_AGC_INITIAL_GAIN,
    );
    this.noiseFloorRms = this.minSpeechRms * 0.4;
  }

  getGain(): number {
    return this.currentGain;
  }

  getGainDb(): number {
    return 20 * Math.log10(Math.max(1e-6, this.currentGain));
  }

  private clampGain(gain: number): number {
    if (!Number.isFinite(gain)) return this.currentGain;
    return Math.max(this.minGain, Math.min(this.maxGain, gain));
  }

  processSamples(samples: Float32Array, durationSec: number): number {
    if (samples.length === 0 || !Number.isFinite(durationSec) || durationSec <= 0) {
      return this.currentGain;
    }

    let sumSq = 0;
    let peak = 0;
    for (let i = 0; i < samples.length; i += 1) {
      const s = samples[i];
      const abs = Math.abs(s);
      if (abs > peak) peak = abs;
      sumSq += s * s;
    }

    const postRms = Math.sqrt(sumSq / samples.length);
    const rawRms = postRms / Math.max(1e-4, this.currentGain);

    // Track ambient room noise floor: drop quickly into quiet gaps, creep upward very slowly on steady hum
    if (rawRms < this.noiseFloorRms) {
      const alphaDown = 1 - Math.exp(-durationSec / 0.25);
      this.noiseFloorRms += (rawRms - this.noiseFloorRms) * alphaDown;
    } else if (rawRms < this.noiseFloorRms * 2.5 || rawRms < this.minSpeechRms) {
      const alphaUp = 1 - Math.exp(-durationSec / 4.0);
      this.noiseFloorRms += (rawRms - this.noiseFloorRms) * alphaUp;
    }
    this.noiseFloorRms = Math.max(1e-5, Math.min(this.noiseFloorRms, 0.02));

    // Peak guard always reacts quickly to prevent hitting the limiter continuously
    let desiredGain = this.currentGain;
    const peakHit = peak >= this.peakCeiling;
    if (peakHit) {
      const peakSafeGain = this.currentGain * ((this.peakCeiling * 0.85) / peak);
      desiredGain = this.clampGain(peakSafeGain);
    }

    // Speech-gated RMS leveling: only boost when speech sits clearly above the noise floor
    const speechGateRms = Math.max(this.minSpeechRms, this.noiseFloorRms * 2.5);
    const isSpeechActive = rawRms >= speechGateRms;

    if (isSpeechActive) {
      const rmsDesired = this.clampGain(this.targetRms / Math.max(1e-5, rawRms));
      desiredGain = peakHit ? Math.min(desiredGain, rmsDesired) : rmsDesired;
    } else if (!peakHit) {
      // Silence or room tone: hold current gain steady to avoid noise-floor pumping
      return this.currentGain;
    }

    // Fast attack when attenuating loud speech; gentle smooth release when lifting quiet speech
    const tau = desiredGain < this.currentGain ? 0.075 : 0.45;
    const alpha = 1 - Math.exp(-durationSec / tau);
    this.currentGain = this.clampGain(
      this.currentGain + (desiredGain - this.currentGain) * alpha,
    );
    return this.currentGain;
  }
}

export interface StudioInputStripOptions {
  enableSoftwareAgc?: boolean;
}

export interface StudioInputStrip {
  tail: AudioNode;
  nodes: AudioNode[];
  autoGainNode: GainNode | null;
  autoGainController: SoftwareAutoGainController | null;
  updateAutoGain: (samples: Float32Array, durationSec: number) => number;
}

/**
 * Builds the StoryTape studio input strip:
 *   source -> [80Hz HPF] -> Input Gain -> [Software Auto-Gain] -> [DynamicsCompressor + Soft-Clip Ceiling (-1 dBFS)]
 *
 * Placing Software Auto-Gain ahead of the DynamicsCompressor + WaveShaper ceiling guarantees
 * that sudden loud voices are immediately protected from clipping at 0 ms overshoot while
 * quiet iPhone/raw mics are lifted cleanly to narration level.
 */
export function buildStudioInputStrip(
  ctx: AudioContext,
  source: AudioNode,
  quality: AudioQualitySettings,
  options?: StudioInputStripOptions,
): StudioInputStrip {
  const nodes: AudioNode[] = [source];
  let tail: AudioNode = source;

  if (quality.highPassFilter) {
    const hpf = ctx.createBiquadFilter();
    hpf.type = 'highpass';
    hpf.frequency.value = 80;
    hpf.Q.value = 0.707;
    tail.connect(hpf);
    tail = hpf;
    nodes.push(hpf);
  }

  const gainNode = ctx.createGain();
  gainNode.gain.value = quality.inputGain;
  tail.connect(gainNode);
  tail = gainNode;
  nodes.push(gainNode);

  let autoGainNode: GainNode | null = null;
  let autoGainController: SoftwareAutoGainController | null = null;
  if (options?.enableSoftwareAgc) {
    const initialGain = Math.max(
      1.0,
      Math.min(
        SOFTWARE_AGC_INITIAL_GAIN,
        SOFTWARE_AGC_INITIAL_GAIN / Math.max(1, quality.inputGain),
      ),
    );
    autoGainController = new SoftwareAutoGainController({ initialGain });
    autoGainNode = ctx.createGain();
    autoGainNode.gain.value = autoGainController.getGain();
    tail.connect(autoGainNode);
    tail = autoGainNode;
    nodes.push(autoGainNode);
  }

  if (quality.softLimiter) {
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -6;
    comp.knee.value = 6;
    comp.ratio.value = 12;
    comp.attack.value = 0.001;
    comp.release.value = 0.1;
    tail.connect(comp);
    tail = comp;
    nodes.push(comp);

    if (typeof ctx.createWaveShaper === 'function') {
      const shaper = ctx.createWaveShaper();
      shaper.curve = buildSoftClipCurve();
      shaper.oversample = '2x';
      tail.connect(shaper);
      tail = shaper;
      nodes.push(shaper);
    }
  }

  let lastAppliedGain = autoGainController?.getGain() ?? 1;
  const updateAutoGain = (samples: Float32Array, durationSec: number): number => {
    if (!autoGainController || !autoGainNode) return 1;
    const nextGain = autoGainController.processSamples(samples, durationSec);
    if (Math.abs(nextGain - lastAppliedGain) < 0.002) {
      return nextGain;
    }
    lastAppliedGain = nextGain;
    const param = autoGainNode.gain;
    if (
      typeof param.setTargetAtTime === 'function' &&
      Number.isFinite(ctx.currentTime)
    ) {
      const now = ctx.currentTime;
      const paramWithCancel = param as AudioParam & {
        cancelAndHoldAtTime?: (cancelTime: number) => AudioParam;
      };
      if (typeof paramWithCancel.cancelAndHoldAtTime === 'function') {
        try {
          paramWithCancel.cancelAndHoldAtTime(now);
        } catch {
          // Ignore if browser rejects cancelAndHoldAtTime at t=0
        }
      } else if (typeof param.cancelScheduledValues === 'function') {
        param.cancelScheduledValues(now);
        if (typeof param.setValueAtTime === 'function') {
          param.setValueAtTime(param.value, now);
        }
      }
      param.setTargetAtTime(nextGain, now, 0.03);
    } else {
      param.value = nextGain;
    }
    return nextGain;
  };

  return {
    tail,
    nodes,
    autoGainNode,
    autoGainController,
    updateAutoGain,
  };
}
