import type { AudioQualitySettings, ChannelCountOption } from '../types/models';

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
 * Transparent vocal safety limiter settings shared by both the Web Audio
 * DynamicsCompressorNode strip (Safari/iOS/Firefox) and pure-TS PcmInputStripProcessor
 * (Chromium/Android MediaStreamTrackProcessor).
 */
export const VOCAL_LIMITER_THRESHOLD_DB = -3;
export const VOCAL_LIMITER_KNEE_DB = 6;
export const VOCAL_LIMITER_RATIO = 4;
export const VOCAL_LIMITER_ATTACK_SEC = 0.005;
export const VOCAL_LIMITER_RELEASE_SEC = 0.12;

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
  if (!Number.isFinite(x)) return 0;
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
 *
 * Invariant: `SOFTWARE_AGC_PEAK_CEILING` (0.56 / -5.0 dBFS) sits strictly below
 * `SOFT_CLIP_THRESHOLD` (0.7071 / -3.0 dBFS) so Software AGC backs off cleanly
 * before sustained limiting or soft-clipping engages.
 */
export const SOFTWARE_AGC_INITIAL_GAIN = 3.16; // +10.0 dB starting lift without slamming syllable #1
export const SOFTWARE_AGC_MIN_GAIN = 0.5; // -6.0 dB floor to tame unexpectedly hot inputs
export const SOFTWARE_AGC_MAX_GAIN = 10.0; // +20.0 dB max lift (avoids extreme room-hiss pumping)
export const SOFTWARE_AGC_TARGET_RMS = 0.09; // ~-20.9 dBFS narration RMS (preserves 15-18 dB vocal crest headroom)
export const SOFTWARE_AGC_PEAK_CEILING = 0.56; // -5.0 dBFS fast-attack peak guard (< -3 dBFS limiter threshold)
export const SOFTWARE_AGC_MIN_SPEECH_RMS = 0.0015; // ~-56.5 dBFS pre-AGC floor below which gain holds
export const SOFTWARE_AGC_COMP_REDUCTION_TRIGGER_DB = -1.5; // Any compressor reduction <= -1.5 dB forces AGC backoff

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
 * Speech-gated, compressor-aware studio Auto-Gain Controller (AGC) used when the user enables
 * Auto Gain Control on a browser/OS (such as Safari/iOS WebKit with echoCancellation=false)
 * that does not provide native `autoGainControl` on the MediaStreamTrack.
 *
 * - Starts at +10 dB (scaled down if user already boosted manual inputGain) so opening syllables
 *   are immediately audible without driving straight into the limiter.
 * - Adapts smoothly upward (~450 ms) toward -21 dBFS RMS during active speech above an adaptive
 *   room-noise floor, holding gain flat during silence so room hiss never pumps between sentences.
 * - Responds rapidly (~75 ms) to pull gain back when peaks exceed -5.0 dBFS OR whenever the
 *   downstream vocal safety limiter reports gain reduction <= -1.5 dB (guaranteeing AGC never
 *   fights the compressor).
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

  processSamples(
    samples: Float32Array,
    durationSec: number,
    compressorReductionDb = 0,
  ): number {
    if (
      samples.length === 0 ||
      !Number.isFinite(durationSec) ||
      durationSec <= 0
    ) {
      return this.currentGain;
    }

    let sumSq = 0;
    let peak = 0;
    for (let i = 0; i < samples.length; i += 1) {
      const s = samples[i];
      if (!Number.isFinite(s)) continue;
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

    // Peak guard + compressor reduction guard react rapidly so AGC never rides the limiter
    let desiredGain = this.currentGain;
    let peakHit = peak >= this.peakCeiling;
    if (peakHit) {
      const peakSafeGain = this.currentGain * ((this.peakCeiling * 0.85) / peak);
      desiredGain = this.clampGain(peakSafeGain);
    }

    const compEngaged =
      Number.isFinite(compressorReductionDb) &&
      compressorReductionDb <= SOFTWARE_AGC_COMP_REDUCTION_TRIGGER_DB;
    if (compEngaged) {
      const reductionLinear = Math.pow(10, (compressorReductionDb - 1.5) / 20);
      const compSafeGain = this.clampGain(this.currentGain * reductionLinear);
      desiredGain = peakHit ? Math.min(desiredGain, compSafeGain) : compSafeGain;
      peakHit = true;
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

    // Never allow a compressor-triggered or peak-triggered update to increase gain
    if (peakHit && desiredGain > this.currentGain) {
      desiredGain = this.currentGain;
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

/**
 * Configures a Web Audio node to extract channel 0 at 1.0x unity gain when recording mono.
 * Prevents Web Audio's default `'speakers'` downmix (`0.5 * (L + R)`) from halving (-6 dB)
 * iOS Safari WebKit's `(L, 0)` mono-in-stereo mic buffers or 1-mic 2-channel USB interfaces.
 */
export function configureMonoDiscreteChannel(node: AudioNode): void {
  try {
    node.channelCount = 1;
    node.channelCountMode = 'explicit';
    node.channelInterpretation = 'discrete';
  } catch {
    // Some unit-test mocks or exotic nodes may make channel properties read-only
  }
}

export interface StudioInputStripOptions {
  enableSoftwareAgc?: boolean;
  channels?: ChannelCountOption;
}

export interface StudioInputStrip {
  tail: AudioNode;
  nodes: AudioNode[];
  autoGainNode: GainNode | null;
  autoGainController: SoftwareAutoGainController | null;
  compressorNode: DynamicsCompressorNode | null;
  updateAutoGain: (samples: Float32Array, durationSec: number) => number;
}

/**
 * Builds the StoryTape studio input strip:
 *   source -> [80Hz HPF] -> Input Gain -> [Software Auto-Gain] -> [Transparent Vocal Limiter + Soft-Clip Ceiling (-1 dBFS)]
 *
 * When recording mono (`channels === 1`), configures every strip node with explicit discrete
 * 1-channel extraction so iOS Safari's `(L, 0)` capture buffers stay at 1.0x unity gain.
 * Placing Software Auto-Gain ahead of the limiter guarantees sudden loud voices are immediately
 * protected at 0 ms overshoot while feeding `comp.reduction` back into AGC so it never overdrives.
 */
export function buildStudioInputStrip(
  ctx: AudioContext,
  source: AudioNode,
  quality: AudioQualitySettings,
  options?: StudioInputStripOptions,
): StudioInputStrip {
  const effectiveChannels: ChannelCountOption =
    options?.channels ?? quality.channels;
  const isMono = effectiveChannels === 1;
  const nodes: AudioNode[] = [source];
  let tail: AudioNode = source;

  if (quality.highPassFilter) {
    const hpf = ctx.createBiquadFilter();
    hpf.type = 'highpass';
    hpf.frequency.value = 80;
    hpf.Q.value = 0.707;
    if (isMono) configureMonoDiscreteChannel(hpf);
    tail.connect(hpf);
    tail = hpf;
    nodes.push(hpf);
  }

  const gainNode = ctx.createGain();
  gainNode.gain.value = quality.inputGain;
  if (isMono) configureMonoDiscreteChannel(gainNode);
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
    if (isMono) configureMonoDiscreteChannel(autoGainNode);
    tail.connect(autoGainNode);
    tail = autoGainNode;
    nodes.push(autoGainNode);
  }

  let compressorNode: DynamicsCompressorNode | null = null;
  if (quality.softLimiter) {
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = VOCAL_LIMITER_THRESHOLD_DB;
    comp.knee.value = VOCAL_LIMITER_KNEE_DB;
    comp.ratio.value = VOCAL_LIMITER_RATIO;
    comp.attack.value = VOCAL_LIMITER_ATTACK_SEC;
    comp.release.value = VOCAL_LIMITER_RELEASE_SEC;
    if (isMono) configureMonoDiscreteChannel(comp);
    tail.connect(comp);
    tail = comp;
    nodes.push(comp);
    compressorNode = comp;

    if (typeof ctx.createWaveShaper === 'function') {
      const shaper = ctx.createWaveShaper();
      shaper.curve = buildSoftClipCurve();
      // Exact 1:1 identity below -3 dBFS with DynamicsCompressor ahead and post-resample
      // ceiling on export: avoid real-time 2x FIR oversampling CPU load on mobile audio threads.
      shaper.oversample = 'none';
      if (isMono) configureMonoDiscreteChannel(shaper);
      tail.connect(shaper);
      tail = shaper;
      nodes.push(shaper);
    }
  }

  let lastAppliedGain = autoGainController?.getGain() ?? 1;
  const updateAutoGain = (samples: Float32Array, durationSec: number): number => {
    if (!autoGainController || !autoGainNode) return 1;
    const reductionDb =
      compressorNode && Number.isFinite(compressorNode.reduction)
        ? compressorNode.reduction
        : 0;
    const nextGain = autoGainController.processSamples(
      samples,
      durationSec,
      reductionDb,
    );
    if (Math.abs(nextGain - lastAppliedGain) < 0.002) {
      return nextGain;
    }
    const prevAppliedGain = lastAppliedGain;
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
          // Hold the last tracked gain (not intrinsic param.value) to prevent gain snap clicks
          param.setValueAtTime(prevAppliedGain, now);
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
    compressorNode,
    updateAutoGain,
  };
}

/**
 * Pure-TypeScript, zero-allocation-per-frame Studio Input Strip matching `buildStudioInputStrip`:
 *   [80Hz Butterworth HPF] -> Input Gain -> [Smoothed Software AGC] -> [Transparent Vocal Limiter + Soft-Clip Ceiling]
 *
 * Used by direct `MediaStreamTrackProcessor` capture on Chromium/Android so we never open an
 * `AudioContext` or cross `MediaStreamAudioSourceNode`'s FIFO during recording.
 */
export class PcmInputStripProcessor {
  private readonly channels: ChannelCountOption;
  private readonly sampleRate: number;
  private readonly hpfEnabled: boolean;
  private readonly inputGain: number;
  private readonly limiterEnabled: boolean;

  // 2nd-order Butterworth 80 Hz HPF biquad coefficients + Direct Form II Transposed state
  private readonly b0: number;
  private readonly b1: number;
  private readonly b2: number;
  private readonly a1: number;
  private readonly a2: number;
  private readonly z1: Float64Array;
  private readonly z2: Float64Array;

  // Optional Software AGC + smooth per-sample ramp
  public readonly autoGainController: SoftwareAutoGainController | null;
  private smoothedAgcGain: number;
  private readonly agcSmoothAlpha: number;

  // Transparent feed-forward vocal peak limiter (-3 dBFS, 4:1, 5ms attack, 120ms release)
  private env = 0;
  private readonly envAttackCoeff: number;
  private readonly envReleaseCoeff: number;
  private readonly limiterThresholdLinear: number;
  private lastReductionDb = 0;
  private minReductionDb = 0;

  constructor(
    sampleRate: number,
    channels: ChannelCountOption,
    quality: AudioQualitySettings,
    enableSoftwareAgc = false,
  ) {
    this.sampleRate = Math.max(8000, sampleRate || 48000);
    this.channels = channels;
    this.hpfEnabled = Boolean(quality.highPassFilter);
    this.inputGain = Number.isFinite(quality.inputGain) ? quality.inputGain : 1;
    this.limiterEnabled = Boolean(quality.softLimiter);

    // Audio EQ Cookbook 2nd-order Butterworth high-pass filter @ 80 Hz, Q = 1/sqrt(2)
    const w0 = (2 * Math.PI * 80) / this.sampleRate;
    const cosW0 = Math.cos(w0);
    const sinW0 = Math.sin(w0);
    const alpha = sinW0 / (2 * Math.SQRT1_2);
    const a0 = 1 + alpha;
    this.b0 = (1 + cosW0) / (2 * a0);
    this.b1 = -(1 + cosW0) / a0;
    this.b2 = (1 + cosW0) / (2 * a0);
    this.a1 = (-2 * cosW0) / a0;
    this.a2 = (1 - alpha) / a0;
    this.z1 = new Float64Array(channels);
    this.z2 = new Float64Array(channels);

    if (enableSoftwareAgc) {
      const initialGain = Math.max(
        1.0,
        Math.min(
          SOFTWARE_AGC_INITIAL_GAIN,
          SOFTWARE_AGC_INITIAL_GAIN / Math.max(1, this.inputGain),
        ),
      );
      this.autoGainController = new SoftwareAutoGainController({ initialGain });
      this.smoothedAgcGain = this.autoGainController.getGain();
    } else {
      this.autoGainController = null;
      this.smoothedAgcGain = 1;
    }
    this.agcSmoothAlpha = 1 - Math.exp(-1 / (0.03 * this.sampleRate));

    this.envAttackCoeff = Math.exp(
      -1 / (VOCAL_LIMITER_ATTACK_SEC * this.sampleRate),
    );
    this.envReleaseCoeff = Math.exp(
      -1 / (VOCAL_LIMITER_RELEASE_SEC * this.sampleRate),
    );
    this.limiterThresholdLinear = Math.pow(10, VOCAL_LIMITER_THRESHOLD_DB / 20);
  }

  getLastReductionDb(): number {
    return this.lastReductionDb;
  }

  getMinReductionDb(): number {
    return this.minReductionDb;
  }

  /**
   * Processes planar `channelBuffers` in-place for `frameCount` frames.
   * Returns `{ peak, reductionDb }` for the processed block.
   */
  processBlock(
    channelBuffers: readonly Float32Array[],
    frameCount: number,
  ): { peak: number; reductionDb: number } {
    if (frameCount <= 0 || channelBuffers.length === 0) {
      return { peak: 0, reductionDb: 0 };
    }

    const chCount = Math.min(this.channels, channelBuffers.length);
    const ch0 = channelBuffers[0];
    const ch1 = chCount > 1 ? channelBuffers[1] : null;
    const targetAgcGain = this.autoGainController
      ? this.autoGainController.getGain()
      : 1;
    const invRatio = 1 / VOCAL_LIMITER_RATIO;
    const thresh = this.limiterThresholdLinear;

    let blockPeak = 0;
    let blockMinReductionDb = 0;

    for (let i = 0; i < frameCount; i += 1) {
      // Smooth Software AGC gain per sample to eliminate zipper noise
      if (this.autoGainController) {
        this.smoothedAgcGain +=
          (targetAgcGain - this.smoothedAgcGain) * this.agcSmoothAlpha;
      }
      const totalGain = this.inputGain * this.smoothedAgcGain;

      // Channel 0
      let s0 = ch0[i];
      if (!Number.isFinite(s0)) s0 = 0;
      if (this.hpfEnabled) {
        const y0 = this.b0 * s0 + this.z1[0];
        this.z1[0] = this.b1 * s0 - this.a1 * y0 + this.z2[0];
        this.z2[0] = this.b2 * s0 - this.a2 * y0;
        s0 = y0;
      }
      s0 *= totalGain;

      // Optional Channel 1 (linked stereo envelope)
      let s1 = 0;
      if (ch1) {
        s1 = ch1[i];
        if (!Number.isFinite(s1)) s1 = 0;
        if (this.hpfEnabled) {
          const y1 = this.b0 * s1 + this.z1[1];
          this.z1[1] = this.b1 * s1 - this.a1 * y1 + this.z2[1];
          this.z2[1] = this.b2 * s1 - this.a2 * y1;
          s1 = y1;
        }
        s1 *= totalGain;
      }

      if (this.limiterEnabled) {
        const linkedAbs = ch1
          ? Math.max(Math.abs(s0), Math.abs(s1))
          : Math.abs(s0);
        const coeff =
          linkedAbs > this.env ? this.envAttackCoeff : this.envReleaseCoeff;
        this.env = coeff * this.env + (1 - coeff) * linkedAbs;

        let compGain = 1;
        if (this.env > thresh) {
          const overDb = 20 * Math.log10(this.env / thresh);
          const reductionDb = -overDb * (1 - invRatio);
          compGain = Math.pow(10, reductionDb / 20);
          if (reductionDb < blockMinReductionDb) {
            blockMinReductionDb = reductionDb;
          }
        }
        s0 = softLimitSample(s0 * compGain);
        if (ch1) {
          s1 = softLimitSample(s1 * compGain);
        }
      }

      ch0[i] = s0;
      const a0 = Math.abs(s0);
      if (a0 > blockPeak) blockPeak = a0;
      if (ch1) {
        ch1[i] = s1;
        const a1 = Math.abs(s1);
        if (a1 > blockPeak) blockPeak = a1;
      }
    }

    this.lastReductionDb = blockMinReductionDb;
    if (blockMinReductionDb < this.minReductionDb) {
      this.minReductionDb = blockMinReductionDb;
    }

    if (this.autoGainController) {
      const agcView = ch0.subarray(0, frameCount);
      this.autoGainController.processSamples(
        agcView,
        frameCount / this.sampleRate,
        blockMinReductionDb,
      );
    }

    return { peak: blockPeak, reductionDb: blockMinReductionDb };
  }
}

